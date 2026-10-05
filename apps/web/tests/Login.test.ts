import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { verifySecret, navigate } = vi.hoisted(() => ({ verifySecret: vi.fn(), navigate: vi.fn() }));

vi.mock("../src/lib/api", () => ({ verifySecret }));
vi.mock("../src/lib/router.svelte", () => ({ navigate }));

import { session } from "../src/lib/session.svelte";
import Login from "../src/views/Login.svelte";

/**
 * The form used to accept any non-empty string and write it to localStorage.
 *
 * That made a wrong password and a Worker that is refusing to serve both look identical: the
 * file list silently failed to load and nothing on screen distinguished them. So the secret is
 * now proved against the server before it is stored, and the server's own message is what gets
 * displayed.
 */
beforeEach(() => {
  verifySecret.mockReset();
  navigate.mockReset();
  session.clear();
  verifySecret.mockResolvedValue(undefined);
});

const submit = async (value: string) => {
  render(Login);
  await fireEvent.input(screen.getByLabelText("访问密钥"), { target: { value } });
  await fireEvent.click(screen.getByRole("button", { name: "进入" }));
};

describe("Login", () => {
  it("checks the secret with the server before storing it", async () => {
    await submit("s3cret");

    await waitFor(() => expect(verifySecret).toHaveBeenCalledWith("s3cret"));
    await waitFor(() => expect(session.secret).toBe("s3cret"));
    expect(navigate).toHaveBeenCalledWith("/");
  });

  it("trims what it sends and what it stores", async () => {
    await submit("  s3cret  ");
    await waitFor(() => expect(verifySecret).toHaveBeenCalledWith("s3cret"));
    expect(session.secret).toBe("s3cret");
  });

  it("stores nothing and stays put when the server rejects it", async () => {
    verifySecret.mockRejectedValue(new Error("未授权，请检查访问密钥"));
    await submit("wrong");

    expect(await screen.findByText("未授权，请检查访问密钥")).toBeInTheDocument();
    expect(session.authed).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("does not call the server for an empty field", async () => {
    await submit("   ");
    expect(await screen.findByText("请输入访问密钥")).toBeInTheDocument();
    expect(verifySecret).not.toHaveBeenCalled();
  });

  it("disables the button while the check is in flight", async () => {
    let release: () => void = () => {};
    verifySecret.mockReturnValue(new Promise<void>((resolve) => void (release = resolve)));
    render(Login);
    await fireEvent.input(screen.getByLabelText("访问密钥"), { target: { value: "s3cret" } });
    await fireEvent.click(screen.getByRole("button", { name: "进入" }));

    expect(await screen.findByRole("button", { name: "验证中…" })).toBeDisabled();
    release();
    await waitFor(() => expect(navigate).toHaveBeenCalled());
  });

  it("re-enables the button so a second attempt is possible", async () => {
    verifySecret.mockRejectedValueOnce(new Error("未授权，请检查访问密钥"));
    await submit("wrong");
    await screen.findByText("未授权，请检查访问密钥");
    expect(screen.getByRole("button", { name: "进入" })).not.toBeDisabled();
  });
});

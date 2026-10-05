type FlashState = { message: string; kind: "ok" | "error" } | null;

let flashState = $state<FlashState>(null);
let timer: ReturnType<typeof setTimeout> | undefined;

export const flash = {
  get value() {
    return flashState;
  },
  show(message: string, kind: "ok" | "error" = "ok") {
    flashState = { message, kind };
    clearTimeout(timer);
    timer = setTimeout(() => (flashState = null), 4000);
  },
  hide() {
    clearTimeout(timer);
    flashState = null;
  },
};

type ConfirmState = { message: string; resolve: (ok: boolean) => void } | null;

let confirmState = $state<ConfirmState>(null);

export const confirmBox = {
  get value() {
    return confirmState;
  },
  answer(ok: boolean) {
    confirmState?.resolve(ok);
    confirmState = null;
  },
};

export const confirmAction = (message: string): Promise<boolean> =>
  new Promise((resolve) => {
    confirmState = { message, resolve };
  });

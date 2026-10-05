const SECRET_KEY = "picoshare.secret";

let secret = $state(localStorage.getItem(SECRET_KEY) ?? "");

export const session = {
  get secret() {
    return secret;
  },
  get authed() {
    return secret !== "";
  },
  set(value: string) {
    secret = value.trim();
    if (secret) localStorage.setItem(SECRET_KEY, secret);
    else localStorage.removeItem(SECRET_KEY);
  },
  clear() {
    secret = "";
    localStorage.removeItem(SECRET_KEY);
  },
};

export type NoticeKind = "info" | "success" | "warning" | "error";

export interface NoticeAction {
  label: string;
  run: () => void;
}

export interface Notice {
  id: number;
  kind: NoticeKind;
  message: string;
  action?: NoticeAction;
}

const DURATION: Record<NoticeKind, number> = {
  info: 4000,
  success: 3500,
  warning: 9000,
  error: 9000,
};

class Notifications {
  items = $state<Notice[]>([]);
  #nextId = 1;
  readonly #timers = new Map<number, ReturnType<typeof setTimeout>>();

  push(kind: NoticeKind, message: string, action?: NoticeAction): number {
    const id = this.#nextId++;
    // Keep the stack short: the oldest notices are the least relevant.
    this.items = [...this.items.slice(-3), { id, kind, message, action }];
    this.#timers.set(
      id,
      setTimeout(() => this.dismiss(id), DURATION[kind] + (action ? 2000 : 0)),
    );
    return id;
  }

  dismiss(id: number): void {
    clearTimeout(this.#timers.get(id));
    this.#timers.delete(id);
    this.items = this.items.filter((notice) => notice.id !== id);
  }

  info(message: string, action?: NoticeAction) {
    return this.push("info", message, action);
  }

  success(message: string, action?: NoticeAction) {
    return this.push("success", message, action);
  }

  warning(message: string, action?: NoticeAction) {
    return this.push("warning", message, action);
  }

  error(message: string, action?: NoticeAction) {
    return this.push("error", message, action);
  }
}

export const notifications = new Notifications();

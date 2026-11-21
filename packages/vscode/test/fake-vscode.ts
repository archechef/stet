/**
 * A stand-in for the `vscode` module in unit tests (vitest.config.ts maps "vscode" to it): the few
 * parts of VS Code's API that the tested modules use, recording what they are asked to do. Tests
 * import `fake` from here to set settings and read what was shown.
 */

export const fake = {
  /** Settings by section and key ("editor" → "accessibilitySupport"). */
  settings: new Map<string, unknown>(),
  statusMessages: [] as { text: string; ms: number | undefined }[],
  notifications: [] as string[],
  reset() {
    this.settings.clear();
    this.statusMessages.length = 0;
    this.notifications.length = 0;
  },
};

export class ThemeColor {
  constructor(readonly id: string) {}
}

export class Disposable {
  constructor(private readonly fn: () => void = () => undefined) {}
  dispose() {
    this.fn();
  }
}

export const workspace = {
  getConfiguration(section?: string) {
    return {
      get<T>(key: string, fallback?: T): T | undefined {
        const k = section ? `${section}.${key}` : key;
        return fake.settings.has(k) ? (fake.settings.get(k) as T) : fallback;
      },
    };
  },
};

export const window = {
  setStatusBarMessage(text: string, ms?: number) {
    fake.statusMessages.push({ text, ms });
    return new Disposable();
  },
  async showInformationMessage(text: string) {
    fake.notifications.push(text);
    return undefined;
  },
  createTextEditorDecorationType(options: unknown) {
    return { options, dispose() {} };
  },
};

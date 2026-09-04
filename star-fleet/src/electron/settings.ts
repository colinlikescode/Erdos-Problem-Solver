import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * API keys/tokens the user can enter in the app. They flow into Pi on the remote
 * VM and override the repo `.env`. ChatGPT Codex accounts come from the broker;
 * this regular OpenAI key is the final fallback after the broker is exhausted.
 */
export interface AppSettings {
  /** Regular OpenAI platform key (sk-…) -> Pi's `openai` provider. */
  openaiApiKey: string;
}

const EMPTY: AppSettings = {
  openaiApiKey: "",
};

/** Plain-JSON settings in userData (keys stored unencrypted, per user request). */
export class SettingsStore {
  private file: string;
  private settings: AppSettings = { ...EMPTY };

  constructor() {
    this.file = path.join(app.getPath("userData"), "settings.json");
    try {
      this.settings = { ...EMPTY, ...JSON.parse(fs.readFileSync(this.file, "utf8")) };
    } catch {
      this.settings = { ...EMPTY };
    }
  }

  get(): AppSettings {
    return { ...this.settings };
  }

  update(patch: Partial<AppSettings>): AppSettings {
    this.settings = { ...this.settings, ...patch };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.settings, null, 2));
    return this.get();
  }
}

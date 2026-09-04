import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { Problem, ProblemCategory } from "../shared/types";

/**
 * Plain-JSON persistence of the saved research problems (name + description)
 * that populate the "New run" dropdown. Lives in the app's userData folder,
 * same as profiles/settings.
 */
export class ProblemStore {
  private file: string;
  private problems: Problem[] = [];

  constructor() {
    this.file = path.join(app.getPath("userData"), "problems.json");
    try {
      this.problems = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      this.problems = [];
    }
  }

  private persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.problems, null, 2));
  }

  list(): Problem[] {
    return [...this.problems];
  }

  get(id: string): Problem | undefined {
    return this.problems.find((p) => p.id === id);
  }

  add(name: string, description: string, category?: ProblemCategory, sourceUrl?: string): Problem {
    const problem: Problem = {
      id: crypto.randomUUID(),
      name: name.trim() || "Untitled problem",
      description: description.trim(),
      ...(category ? { category } : {}),
      ...(sourceUrl?.trim() ? { sourceUrl: sourceUrl.trim() } : {}),
      createdAt: Date.now(),
    };
    this.problems.push(problem);
    this.persist();
    return problem;
  }

  remove(id: string): void {
    this.problems = this.problems.filter((p) => p.id !== id);
    this.persist();
  }
}

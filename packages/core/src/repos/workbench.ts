import type { Db, Row } from "../db.js";
import { j, num, str, strOrUndef } from "../db.js";
import { newId } from "../ids.js";
import type { Dataset, DatasetItem, Json, Message, ModelConfig, Project, Prompt, PromptVersion } from "../schema.js";

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const rowProject = (r: Row): Project => ({ id: str(r.id), name: str(r.name), slug: str(r.slug), createdAt: num(r.created_at) });
const rowPrompt = (r: Row): Prompt => ({
  id: str(r.id), projectId: str(r.project_id), name: str(r.name), description: strOrUndef(r.description), createdAt: num(r.created_at),
});
const rowVersion = (r: Row): PromptVersion => ({
  id: str(r.id), promptId: str(r.prompt_id), version: num(r.version),
  template: j.dec<Message[]>(r.template, []), config: j.dec<ModelConfig>(r.config, { model: "" }),
  variables: j.dec<string[]>(r.variables, []), commitMessage: strOrUndef(r.commit_message),
  labels: j.dec<string[]>(r.labels, []), createdAt: num(r.created_at),
});
const rowDataset = (r: Row): Dataset => ({
  id: str(r.id), projectId: str(r.project_id), name: str(r.name), description: strOrUndef(r.description), createdAt: num(r.created_at),
});
const rowItem = (r: Row): DatasetItem => ({
  id: str(r.id), datasetId: str(r.dataset_id), input: j.dec<Record<string, Json>>(r.input, {}),
  expected: j.dec<Json | undefined>(r.expected, undefined), metadata: j.dec<Record<string, Json> | undefined>(r.metadata, undefined),
  createdAt: num(r.created_at),
});

/** Extract `{{var}}` placeholders from a template. */
export function extractVariables(template: Message[]): string[] {
  const vars = new Set<string>();
  const re = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g;
  for (const m of template) {
    const texts = typeof m.content === "string" ? [m.content] : m.content.flatMap((p) => (p.type === "text" ? [p.text] : []));
    for (const t of texts) for (const match of t.matchAll(re)) vars.add(match[1]!);
  }
  return [...vars];
}

/** Render a template with variables. Missing variables are left intact so they are visible in traces. */
export function renderTemplate(template: Message[], vars: Record<string, unknown>): Message[] {
  const sub = (t: string) =>
    t.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g, (whole, name: string) => {
      const v = name.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), vars);
      if (v === undefined) return whole;
      return typeof v === "string" ? v : JSON.stringify(v);
    });
  return template.map((m) => ({
    ...m,
    content: typeof m.content === "string" ? sub(m.content) : m.content.map((p) => (p.type === "text" ? { ...p, text: sub(p.text) } : p)),
  }));
}

export class WorkbenchRepo {
  constructor(private db: Db) {}

  // Projects
  createProject(name: string): Project {
    const p: Project = { id: newId.project(), name, slug: slugify(name), createdAt: Date.now() };
    this.db.run("INSERT INTO projects (id, name, slug, created_at) VALUES (?, ?, ?, ?)", p.id, p.name, p.slug, p.createdAt);
    return p;
  }
  getProject(idOrSlug: string): Project | undefined {
    const r = this.db.get("SELECT * FROM projects WHERE id = ? OR slug = ?", idOrSlug, idOrSlug);
    return r ? rowProject(r) : undefined;
  }
  listProjects(): Project[] {
    return this.db.all("SELECT * FROM projects ORDER BY created_at").map(rowProject);
  }
  ensureDefaultProject(): Project {
    return this.getProject("default") ?? this.createProject("default");
  }
  deleteProject(id: string): void {
    this.db.run("DELETE FROM projects WHERE id = ?", id);
  }

  // Prompts
  createPrompt(projectId: string, name: string, description?: string): Prompt {
    const p: Prompt = { id: newId.prompt(), projectId, name, description, createdAt: Date.now() };
    this.db.run("INSERT INTO prompts (id, project_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)", p.id, projectId, name, description ?? null, p.createdAt);
    return p;
  }
  getPrompt(projectId: string, idOrName: string): Prompt | undefined {
    const r = this.db.get("SELECT * FROM prompts WHERE project_id = ? AND (id = ? OR name = ?)", projectId, idOrName, idOrName);
    return r ? rowPrompt(r) : undefined;
  }
  listPrompts(projectId: string): Array<Prompt & { versionCount: number; latestVersion: number | null }> {
    return this.db
      .all(
        `SELECT p.*, COUNT(v.id) AS version_count, MAX(v.version) AS latest_version
         FROM prompts p LEFT JOIN prompt_versions v ON v.prompt_id = p.id
         WHERE p.project_id = ? GROUP BY p.id ORDER BY p.name`,
        projectId,
      )
      .map((r) => ({ ...rowPrompt(r), versionCount: num(r.version_count), latestVersion: r.latest_version == null ? null : num(r.latest_version) }));
  }
  createVersion(promptId: string, input: { template: Message[]; config: ModelConfig; commitMessage?: string; labels?: string[] }): PromptVersion {
    return this.db.transaction(() => {
      const last = this.db.get<{ v: number | null }>("SELECT MAX(version) AS v FROM prompt_versions WHERE prompt_id = ?", promptId);
      const v: PromptVersion = {
        id: newId.promptVersion(), promptId, version: Number(last?.v ?? 0) + 1, template: input.template, config: input.config,
        variables: extractVariables(input.template), commitMessage: input.commitMessage, labels: input.labels ?? [], createdAt: Date.now(),
      };
      // Labels are unique per prompt (e.g. "production" moves to the new version).
      for (const label of v.labels) this.removeLabel(promptId, label);
      this.db.run(
        `INSERT INTO prompt_versions (id, prompt_id, version, template, config, variables, commit_message, labels, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        v.id, promptId, v.version, j.enc(v.template), j.enc(v.config), j.enc(v.variables), v.commitMessage ?? null, j.enc(v.labels), v.createdAt,
      );
      return v;
    });
  }
  getVersion(id: string): PromptVersion | undefined {
    const r = this.db.get("SELECT * FROM prompt_versions WHERE id = ?", id);
    return r ? rowVersion(r) : undefined;
  }
  listVersions(promptId: string): PromptVersion[] {
    return this.db.all("SELECT * FROM prompt_versions WHERE prompt_id = ? ORDER BY version DESC", promptId).map(rowVersion);
  }
  /** Resolve `name@3`, `name@production`, or `name` (latest). */
  resolveVersion(projectId: string, ref: string): PromptVersion | undefined {
    const [name, sel] = ref.split("@") as [string, string | undefined];
    const prompt = this.getPrompt(projectId, name);
    if (!prompt) return undefined;
    const versions = this.listVersions(prompt.id);
    if (!sel) return versions[0];
    if (/^\d+$/.test(sel)) return versions.find((v) => v.version === Number(sel));
    return versions.find((v) => v.labels.includes(sel));
  }
  setLabel(versionId: string, label: string): PromptVersion | undefined {
    const v = this.getVersion(versionId);
    if (!v) return undefined;
    this.removeLabel(v.promptId, label);
    const labels = [...new Set([...v.labels, label])];
    this.db.run("UPDATE prompt_versions SET labels = ? WHERE id = ?", j.enc(labels), versionId);
    return { ...v, labels };
  }
  private removeLabel(promptId: string, label: string): void {
    for (const v of this.listVersions(promptId)) {
      if (v.labels.includes(label)) this.db.run("UPDATE prompt_versions SET labels = ? WHERE id = ?", j.enc(v.labels.filter((l) => l !== label)), v.id);
    }
  }

  // Datasets
  createDataset(projectId: string, name: string, description?: string): Dataset {
    const d: Dataset = { id: newId.dataset(), projectId, name, description, createdAt: Date.now() };
    this.db.run("INSERT INTO datasets (id, project_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)", d.id, projectId, name, description ?? null, d.createdAt);
    return d;
  }
  getDataset(projectId: string, idOrName: string): Dataset | undefined {
    const r = this.db.get("SELECT * FROM datasets WHERE project_id = ? AND (id = ? OR name = ?)", projectId, idOrName, idOrName);
    return r ? rowDataset(r) : undefined;
  }
  getDatasetById(id: string): Dataset | undefined {
    const r = this.db.get("SELECT * FROM datasets WHERE id = ?", id);
    return r ? rowDataset(r) : undefined;
  }
  listDatasets(projectId: string): Array<Dataset & { itemCount: number }> {
    return this.db
      .all(
        `SELECT d.*, COUNT(i.id) AS item_count FROM datasets d LEFT JOIN dataset_items i ON i.dataset_id = d.id
         WHERE d.project_id = ? GROUP BY d.id ORDER BY d.name`,
        projectId,
      )
      .map((r) => ({ ...rowDataset(r), itemCount: num(r.item_count) }));
  }
  addItems(datasetId: string, items: Array<{ input: Record<string, Json>; expected?: Json; metadata?: Record<string, Json> }>): DatasetItem[] {
    return this.db.transaction(() =>
      items.map((it) => {
        const item: DatasetItem = { id: newId.datasetItem(), datasetId, input: it.input, expected: it.expected, metadata: it.metadata, createdAt: Date.now() };
        this.db.run(
          "INSERT INTO dataset_items (id, dataset_id, input, expected, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          item.id, datasetId, j.enc(item.input), j.enc(item.expected), j.enc(item.metadata), item.createdAt,
        );
        return item;
      }),
    );
  }
  listItems(datasetId: string, limit = 10_000): DatasetItem[] {
    return this.db.all("SELECT * FROM dataset_items WHERE dataset_id = ? ORDER BY created_at LIMIT ?", datasetId, limit).map(rowItem);
  }
  deleteItem(id: string): void {
    this.db.run("DELETE FROM dataset_items WHERE id = ?", id);
  }
}

import { join } from "node:path";
import { SqliteDb, type Db } from "./db.js";
import { PostgresDb } from "./pg/postgres-db.js";
import { AgentsRepo } from "./repos/agents.js";
import { EvalsRepo } from "./repos/evals.js";
import { GatewayRepo } from "./repos/gateway.js";
import { OpsRepo } from "./repos/ops.js";
import { RagRepo } from "./repos/rag.js";
import { TracingRepo } from "./repos/tracing.js";
import { WorkbenchRepo } from "./repos/workbench.js";

export interface StoreOptions {
  /** Directory for Crucible data. Defaults to $CRUCIBLE_HOME or ./.crucible */
  home?: string;
  /** SQLite file path. Use ":memory:" for tests. Ignored when `url` is set. */
  path?: string;
  /**
   * Database URL. Defaults to $CRUCIBLE_DATABASE_URL. Supported:
   *   postgres://user:pass@host:5432/crucible   shared Postgres for teams
   *   pglite://memory | pglite://./dir           embedded Postgres (WASM), handy for tests and parity checks
   *   (unset)                                    SQLite file under `home`
   */
  url?: string;
}

export function openDb(opts: StoreOptions, home: string): Db {
  const url = opts.url ?? (opts.path ? undefined : process.env.CRUCIBLE_DATABASE_URL);
  if (url && (url.startsWith("postgres://") || url.startsWith("postgresql://") || url.startsWith("pglite://"))) return new PostgresDb(url);
  if (url) throw new Error(`unsupported CRUCIBLE_DATABASE_URL: ${url}`);
  return new SqliteDb({ path: opts.path ?? join(home, "crucible.db") });
}

/** The single entry point to all persisted state. One SQLite file, many repositories. */
export class Store {
  readonly db: Db;
  readonly home: string;
  readonly workbench: WorkbenchRepo;
  readonly tracing: TracingRepo;
  readonly evals: EvalsRepo;
  readonly agents: AgentsRepo;
  readonly gateway: GatewayRepo;
  readonly rag: RagRepo;
  readonly ops: OpsRepo;

  constructor(opts: StoreOptions = {}) {
    this.home = opts.home ?? process.env.CRUCIBLE_HOME ?? join(process.cwd(), ".crucible");
    this.db = openDb(opts, this.home);
    this.workbench = new WorkbenchRepo(this.db);
    this.tracing = new TracingRepo(this.db);
    this.evals = new EvalsRepo(this.db);
    this.agents = new AgentsRepo(this.db);
    this.gateway = new GatewayRepo(this.db);
    this.rag = new RagRepo(this.db);
    this.ops = new OpsRepo(this.db);
  }

  static memory(): Store {
    return new Store({ path: ":memory:" });
  }

  /** In-process Postgres (PGlite) with no server: used by tests to keep both dialects honest. */
  static pglite(): Store {
    return new Store({ url: "pglite://memory" });
  }

  get dialect() {
    return this.db.dialect;
  }

  close(): void {
    this.db.close();
  }
}

import { join } from "node:path";
import { Db } from "./db.js";
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
  /** Use ":memory:" for tests. */
  path?: string;
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
    this.db = new Db({ path: opts.path ?? join(this.home, "crucible.db") });
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

  close(): void {
    this.db.close();
  }
}

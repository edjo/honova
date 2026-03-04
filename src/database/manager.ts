import type { Context } from "hono";

export type DbLifecycleStrategy = "request" | "manual";

export interface DbLifecycleOptions {
  strategy?: DbLifecycleStrategy;
}

export interface DatabaseAdapterConnectArgs<
  Env extends Record<string, unknown>,
  Options,
> {
  url: string;
  options: Options;
  env: Env;
  context: Context<{ Bindings: Env; Variables: Record<string, unknown> }>;
}

export interface DatabaseAdapter<
  Env extends Record<string, unknown> = Record<string, unknown>,
  Client = unknown,
  Options = unknown,
> {
  name: string;
  connect: (args: DatabaseAdapterConnectArgs<Env, Options>) => Promise<Client> | Client;
  disconnect?(client: Client): Promise<void> | void;
}

export interface DatabaseConnectionDefinition<
  Env extends Record<string, unknown> = Record<string, unknown>,
  ConnectionName extends string = string,
  Client = unknown,
  Options = unknown,
> {
  connectionName: ConnectionName;
  adapter: DatabaseAdapter<Env, Client, Options>;
  options?: Options;
  url?: string;
  urlFromEnv?: Extract<keyof Env, string> | string;
  resolveUrl?: (
    c: Context<{ Bindings: Env; Variables: Record<string, unknown> }>,
  ) => string | Promise<string>;
  required?: boolean;
  eager?: boolean;
}

export type DatabaseConnectionDefinitions<
  Env extends Record<string, unknown> = Record<string, unknown>,
> = readonly DatabaseConnectionDefinition<Env, string, unknown, unknown>[];

export interface DatabaseConfig<
  Env extends Record<string, unknown> = Record<string, unknown>,
  TConnections extends DatabaseConnectionDefinitions<Env> = DatabaseConnectionDefinitions<Env>,
> {
  defaultConnection?: TConnections[number]["connectionName"];
  connections: TConnections;
  lifecycle?: DbLifecycleOptions;
}

type ConnectionClient<TConnection> =
  TConnection extends DatabaseConnectionDefinition<any, any, infer Client, any>
    ? Client
    : never;

export type InferDbConnectionsFromDefinitions<
  TConnections extends readonly DatabaseConnectionDefinition<any, any, any, any>[],
> = {
  [TConnection in TConnections[number] as TConnection["connectionName"]]: ConnectionClient<TConnection>;
};

type InferDefaultName<
  TConnections extends readonly DatabaseConnectionDefinition<any, any, any, any>[],
  TDefault,
> = TDefault extends string
  ? TDefault
  : TConnections extends readonly [infer First, ...infer _Rest]
    ? First extends DatabaseConnectionDefinition<any, infer Name, any, any>
      ? Name
      : never
    : never;

export type InferDbDefaultClient<
  TDatabase extends DatabaseConfig<any, any>,
> = TDatabase extends DatabaseConfig<any, infer TConnections>
  ? InferDbConnectionsFromDefinitions<TConnections>[InferDefaultName<TConnections, TDatabase["defaultConnection"]>]
  : never;

export type InferDbConnectionsFromDatabase<
  TDatabase extends DatabaseConfig<any, any>,
> = TDatabase extends DatabaseConfig<any, infer TConnections>
  ? InferDbConnectionsFromDefinitions<TConnections>
  : never;

export type InferDbDefaultAndConnections<
  TDatabase extends DatabaseConfig<any, any>,
> = InferDbDefaultClient<TDatabase> & InferDbConnectionsFromDatabase<TDatabase>;

export function defineDatabase<
  Env extends Record<string, unknown>,
  const TConnections extends DatabaseConnectionDefinitions<Env>,
>(config: DatabaseConfig<Env, TConnections>): DatabaseConfig<Env, TConnections>;
export function defineDatabase<Env extends Record<string, unknown>>(): <
  const TConnections extends DatabaseConnectionDefinitions<Env>,
>(
  config: DatabaseConfig<Env, TConnections>,
) => DatabaseConfig<Env, TConnections>;
export function defineDatabase<
  Env extends Record<string, unknown>,
  const TConnections extends DatabaseConnectionDefinitions<Env>,
>(
  config?: DatabaseConfig<Env, TConnections>,
):
  | DatabaseConfig<Env, TConnections>
  | (<const TResolvedConnections extends DatabaseConnectionDefinitions<Env>>(
      resolved: DatabaseConfig<Env, TResolvedConnections>,
    ) => DatabaseConfig<Env, TResolvedConnections>) {
  if (config) {
    return config;
  }

  return <const TResolvedConnections extends DatabaseConnectionDefinitions<Env>>(
    resolved: DatabaseConfig<Env, TResolvedConnections>,
  ): DatabaseConfig<Env, TResolvedConnections> => resolved;
}

interface ResolvedConnectionDefinition<
  Env extends Record<string, unknown>,
  Client,
  Options,
> {
  connectionName: string;
  required: boolean;
  eager: boolean;
  adapter: DatabaseAdapter<Env, Client, Options>;
  options: Options;
  url?: string;
  urlFromEnv?: string;
  resolveUrl?: (
    c: Context<{ Bindings: Env; Variables: Record<string, unknown> }>,
  ) => string | Promise<string>;
}

export class DatabaseManager<
  Env extends Record<string, unknown>,
  TDatabase extends DatabaseConfig<Env, DatabaseConnectionDefinitions<Env>>,
> {
  private readonly definitions = new Map<
    string,
    ResolvedConnectionDefinition<Env, unknown, unknown>
  >();
  private readonly connected = new Map<string, unknown>();
  private readonly dbConnections: Partial<InferDbConnectionsFromDatabase<TDatabase>> = {};
  private readonly defaultConnectionName: string;
  private static readonly optionalConnectionUnavailablePrefix = "Optional database connection";

  constructor(
    private readonly env: Env,
    private readonly context: Context<{ Bindings: Env; Variables: Record<string, unknown> }>,
    private readonly config: TDatabase,
  ) {
    if (!config.connections || config.connections.length === 0) {
      throw new Error("Database configuration must include at least one connection.");
    }

    for (const connection of config.connections) {
      if (this.definitions.has(connection.connectionName)) {
        throw new Error(
          `Duplicate database connection \"${connection.connectionName}\". Connection names must be unique.`,
        );
      }

      this.definitions.set(connection.connectionName, {
        connectionName: connection.connectionName,
        required: connection.required !== false,
        eager: connection.eager === true,
        adapter: connection.adapter,
        options: connection.options,
        url: connection.url,
        urlFromEnv: connection.urlFromEnv ? String(connection.urlFromEnv) : undefined,
        resolveUrl: connection.resolveUrl,
      });
    }

    const connectionNames = [...this.definitions.keys()];
    if (connectionNames.length > 1 && !config.defaultConnection) {
      throw new Error(
        "When multiple database connections are configured, defaultConnection is required.",
      );
    }

    this.defaultConnectionName =
      String(config.defaultConnection ?? connectionNames[0]);

    if (!this.definitions.has(this.defaultConnectionName)) {
      throw new Error(
        `defaultConnection \"${this.defaultConnectionName}\" is not present in connections list.`,
      );
    }

    const defaultDefinition = this.definitions.get(this.defaultConnectionName);
    if (defaultDefinition && !defaultDefinition.required) {
      throw new Error("defaultConnection cannot be optional (required must not be false).");
    }
  }

  async initialize(): Promise<InferDbDefaultAndConnections<TDatabase>> {
    const connectionNamesToInitialize = new Set<string>([this.defaultConnectionName]);

    const eagerConnections = [...this.definitions.values()]
      .filter((definition) => definition.eager)
      .map((definition) => definition.connectionName);

    for (const connectionName of eagerConnections) {
      connectionNamesToInitialize.add(connectionName);
    }

    await Promise.all(
      [...connectionNamesToInitialize].map((name) => this.initializeConnection(name)),
    );

    return this.db;
  }

  async connection<TName extends keyof InferDbConnectionsFromDatabase<TDatabase> & string>(
    connectionName: TName,
  ): Promise<InferDbConnectionsFromDatabase<TDatabase>[TName]>;
  async connection(connectionName: string): Promise<unknown> {
    if (this.connected.has(connectionName)) {
      return this.connected.get(connectionName);
    }

    const definition = this.definitions.get(connectionName);
    if (!definition) {
      const available = [...this.definitions.keys()].join(", ") || "none";
      throw new Error(
        `Database connection \"${connectionName}\" is not configured. Available: ${available}.`,
      );
    }

    const url = await this.resolveConnectionUrl(definition);
    if (!url) {
      if (definition.required) {
        throw new Error(
          `Could not resolve URL for required database connection \"${connectionName}\". Configure resolveUrl, url or urlFromEnv.`,
        );
      }

      throw new Error(
        `Optional database connection \"${connectionName}\" is unavailable (URL not resolved).`,
      );
    }

    const client = await definition.adapter.connect({
      url,
      options: definition.options,
      env: this.env,
      context: this.context,
    });

    this.connected.set(connectionName, client);
    (this.dbConnections as Record<string, unknown>)[connectionName] = client;

    return client;
  }

  get defaultConnection(): string {
    return this.defaultConnectionName;
  }

  get connections(): InferDbConnectionsFromDatabase<TDatabase> {
    return this.dbConnections as InferDbConnectionsFromDatabase<TDatabase>;
  }

  get db(): InferDbDefaultAndConnections<TDatabase> {
    const map = this.connections as Record<string, unknown>;
    const defaultClient = map[this.defaultConnectionName];

    if (!defaultClient || typeof defaultClient !== "object") {
      return defaultClient as InferDbDefaultAndConnections<TDatabase>;
    }

    return new Proxy(defaultClient as object, {
      get(target, property, receiver) {
        if (typeof property === "string" && property in map) {
          return map[property];
        }

        return Reflect.get(target, property, receiver);
      },
      has(target, property) {
        if (typeof property === "string" && property in map) {
          return true;
        }

        return Reflect.has(target, property);
      },
    }) as InferDbDefaultAndConnections<TDatabase>;
  }

  async cleanup(): Promise<void> {
    const disconnections = [...this.connected.entries()].map(async ([name, client]) => {
      const definition = this.definitions.get(name);
      if (!definition?.adapter.disconnect) {
        return;
      }

      await definition.adapter.disconnect(client as never);
    });

    await Promise.all(disconnections);

    this.connected.clear();
    for (const key of Object.keys(this.dbConnections as Record<string, unknown>)) {
      delete (this.dbConnections as Record<string, unknown>)[key];
    }
  }

  private async initializeConnection(connectionName: string): Promise<void> {
    try {
      await this.connection(connectionName);
    } catch (error) {
      const definition = this.definitions.get(connectionName);
      if (!definition) {
        throw error;
      }

      if (definition.required) {
        throw error;
      }

      if (
        error instanceof Error &&
        error.message.startsWith(DatabaseManager.optionalConnectionUnavailablePrefix)
      ) {
        return;
      }

      throw error;
    }
  }

  private async resolveConnectionUrl(
    definition: ResolvedConnectionDefinition<Env, unknown, unknown>,
  ): Promise<string> {
    if (definition.resolveUrl) {
      const resolved = await definition.resolveUrl(this.context);
      return typeof resolved === "string" ? resolved.trim() : "";
    }

    if (typeof definition.url === "string") {
      return definition.url.trim();
    }

    if (definition.urlFromEnv) {
      const value = this.env[definition.urlFromEnv as keyof Env];
      return typeof value === "string" ? value.trim() : "";
    }

    return "";
  }
}

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  MemoryService,
  VALID_CATEGORIES,
  type IMemoryService,
  type MemoryServiceOptions,
  type ObservationWithEntities,
  type SearchResult,
  type MemoryStats,
  type ObservationCategory,
  type SymbolInput,
} from "../service/index.js";

export { type IMemoryService };

/**
 * Zod schema for symbol / entity objects.
 */
export const SymbolSchema = z
  .object({
    name: z.string().trim().nullish(),
    filePath: z.string().trim().nullish(),
    file_path: z.string().trim().nullish(),
    identifier: z.string().trim().nullish(),
    type: z
      .enum(["file", "function", "class", "interface", "module"])
      .nullish(),
    entity_type: z
      .enum(["file", "function", "class", "interface", "module"])
      .nullish(),
    id: z.string().trim().nullish(),
  })
  .passthrough()
  .refine(
    (s) => Boolean(s.name || s.identifier || s.filePath || s.file_path),
    {
      message:
        "Symbol must provide at least one of name, identifier, or filePath",
    }
  );

/**
 * Schema for observation category.
 */
export const CategorySchema = z
  .enum(
    VALID_CATEGORIES as unknown as [ObservationCategory, ...ObservationCategory[]]
  )
  .describe(`Allowed observation category: ${VALID_CATEGORIES.join(", ")}`);

/**
 * Zod schema for muninn_save tool arguments.
 */
export const MuninnSaveSchema = z.object({
  category: CategorySchema,
  title: z
    .string()
    .trim()
    .min(1, "Observation title is required and cannot be empty")
    .max(1000, "Observation title cannot exceed 1000 characters")
    .describe("Concise title summarizing the observation"),
  content: z
    .string()
    .trim()
    .min(1, "Observation content is required and cannot be empty")
    .max(1_000_000, "Observation content cannot exceed 1,000,000 characters")
    .describe("Detailed markdown or text content of the observation"),
  topicKey: z
    .string()
    .trim()
    .max(256, "Topic key cannot exceed 256 characters")
    .nullish()
    .describe("Optional clustering key to group related observations (e.g. auth, db)"),
  symbols: z
    .array(z.union([z.string().trim().min(1), SymbolSchema]))
    .max(500, "Symbols array cannot exceed 500 items")
    .nullish()
    .describe("Optional symbols or code entities linked to this observation"),
});

export type MuninnSaveInput = z.infer<typeof MuninnSaveSchema>;

/**
 * Zod schema for muninn_search tool arguments.
 */
export const MuninnSearchSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1, "Search query is required and cannot be empty")
    .max(2000, "Search query cannot exceed 2000 characters")
    .describe("Full-text search query with BM25 ranking"),
  category: CategorySchema.nullish().describe("Optional category filter"),
  limit: z
    .number()
    .int("Limit must be an integer")
    .positive("Limit must be positive")
    .max(500, "Limit cannot exceed 500")
    .nullish()
    .default(10)
    .describe("Maximum number of results to return (default 10, max 500)"),
  allProjects: z
    .boolean()
    .nullish()
    .describe("Whether to search across all projects (default false)"),
});

export type MuninnSearchInput = z.infer<typeof MuninnSearchSchema>;

/**
 * Zod schema for muninn_context tool arguments.
 */
export const MuninnContextSchema = z.object({
  limit: z
    .number()
    .int("Limit must be an integer")
    .positive("Limit must be positive")
    .max(500, "Limit cannot exceed 500")
    .nullish()
    .default(20)
    .describe("Maximum number of recent observations to return (default 20, max 500)"),
  category: CategorySchema.nullish().describe("Optional category filter"),
  topicKey: z
    .string()
    .trim()
    .max(256, "Topic key cannot exceed 256 characters")
    .nullish()
    .describe("Optional topic key filter"),
  allProjects: z
    .boolean()
    .nullish()
    .describe("Whether to query across all projects (default false)"),
});

export type MuninnContextInput = z.infer<typeof MuninnContextSchema>;

/**
 * Zod schema for muninn_link_symbol tool arguments.
 */
export const MuninnLinkSymbolSchema = z.object({
  observationId: z
    .string()
    .trim()
    .min(1, "observationId is required and cannot be empty")
    .describe("ID of the observation to link the symbol to"),
  symbol: z
    .union([z.string().trim().min(1, "Symbol is required"), SymbolSchema])
    .describe("Symbol string (e.g. 'src/app.ts::run') or SymbolInput object"),
});

export type MuninnLinkSymbolInput = z.infer<typeof MuninnLinkSymbolSchema>;

/**
 * Zod schema for muninn_stats tool arguments.
 */
export const MuninnStatsSchema = z.object({
  allProjects: z
    .boolean()
    .nullish()
    .describe("Whether to report metrics across all projects (default false)"),
});

export type MuninnStatsInput = z.infer<typeof MuninnStatsSchema>;

/**
 * Helper to format Zod validation errors into a human-readable string.
 */
export function formatZodErrors(error: z.ZodError): string {
  if (error.issues && Array.isArray(error.issues) && error.issues.length > 0) {
    return error.issues
      .map((issue) => {
        const path = issue.path.join(".");
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join(", ");
  }
  return error.message;
}

export interface ToolDefinition<
  TSchema extends z.ZodTypeAny = any,
  TOutput = unknown
> {
  name: string;
  description: string;
  schema: TSchema;
  handler: (
    service: IMemoryService,
    input: z.infer<TSchema>
  ) => TOutput | Promise<TOutput>;
}

export const TOOL_REGISTRY: Record<string, ToolDefinition> = {
  muninn_save: {
    name: "muninn_save",
    description:
      "Save an observation (decision, convention, discovery, bugfix, architecture) to Muninn memory with optional linked entities.",
    schema: MuninnSaveSchema,
    handler: (service, input) => service.saveObservation(input),
  },
  muninn_search: {
    name: "muninn_search",
    description:
      "Search observations in Muninn memory using full-text search with BM25 ranking.",
    schema: MuninnSearchSchema,
    handler: (service, input) => service.search(input),
  },
  muninn_context: {
    name: "muninn_context",
    description:
      "Retrieve recent observations and context from Muninn memory, optionally filtered by category or topic.",
    schema: MuninnContextSchema,
    handler: (service, input) => service.getContext(input),
  },
  muninn_link_symbol: {
    name: "muninn_link_symbol",
    description:
      "Link a code entity/symbol to an existing observation in Muninn memory.",
    schema: MuninnLinkSymbolSchema,
    handler: (service, input) =>
      service.linkSymbol(
        input.observationId,
        input.symbol as SymbolInput | string
      ),
  },
  muninn_stats: {
    name: "muninn_stats",
    description:
      "Get memory statistics (counts of projects, observations, entities, and links).",
    schema: MuninnStatsSchema,
    handler: (service, input) =>
      input.allProjects
        ? service.getStats()
        : service.getStats(service.currentProject.id),
  },
};

/**
 * Metadata definition for all Muninn MCP tools.
 */
export const MUNINN_TOOLS: Tool[] = Object.values(TOOL_REGISTRY).map(
  (tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.schema) as Tool["inputSchema"],
  })
);

export const TOOL_NAMES = [
  "muninn_save",
  "muninn_search",
  "muninn_context",
  "muninn_link_symbol",
  "muninn_stats",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

const PROTOTYPE_POLLUTION_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/**
 * Normalizes input arguments (handling snake_case fallbacks and null/undefined values),
 * hardened against prototype pollution by skipping __proto__, constructor, and prototype keys.
 */
export function normalizeArgs(
  args: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return {};
  }
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (PROTOTYPE_POLLUTION_KEYS.has(key)) {
      continue;
    }
    if (value !== null && value !== undefined) {
      normalized[key] = value;
    }
  }
  if (normalized.topic_key !== undefined && normalized.topicKey === undefined) {
    normalized.topicKey = normalized.topic_key;
  }
  if (
    normalized.observation_id !== undefined &&
    normalized.observationId === undefined
  ) {
    normalized.observationId = normalized.observation_id;
  }
  if (
    normalized.all_projects !== undefined &&
    normalized.allProjects === undefined
  ) {
    normalized.allProjects = normalized.all_projects;
  }
  return normalized;
}

/**
 * Type guard to check if an object satisfies the IMemoryService interface.
 */
export function isMemoryService(obj: unknown): obj is IMemoryService {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "saveObservation" in obj &&
    typeof (obj as IMemoryService).saveObservation === "function" &&
    "search" in obj &&
    typeof (obj as IMemoryService).search === "function"
  );
}

export type MuninnServer = Server & {
  service: IMemoryService;
  memoryService: IMemoryService;
};

/**
 * Creates and configures a Model Context Protocol (MCP) server for Muninn memory.
 */
export function createMcpServer(
  serviceOrOptions?: IMemoryService | MemoryServiceOptions
): MuninnServer {
  const service: IMemoryService = isMemoryService(serviceOrOptions)
    ? serviceOrOptions
    : new MemoryService(serviceOrOptions);

  const server = new Server(
    {
      name: "muninn-memory",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Store service reference on server instance with typed properties
  const mcpServer = Object.assign(server, {
    service,
    memoryService: service,
  }) as MuninnServer;

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: MUNINN_TOOLS,
    };
  });

  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const { name } = request.params;
      const tool = TOOL_REGISTRY[name];
      if (!tool) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error: Unknown tool "${name}"`,
            },
          ],
        };
      }

      const rawArgs = request.params.arguments;
      const args = normalizeArgs(rawArgs as Record<string, unknown> | undefined);

      const parsed = tool.schema.safeParse(args);
      if (!parsed.success) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Validation error: ${formatZodErrors(parsed.error)}`,
            },
          ],
        };
      }

      const result = await tool.handler(service, parsed.data);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err: unknown) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  });

  return mcpServer;
}

/**
 * Starts the Muninn MCP server using StdioServerTransport.
 */
export async function startMcpServer(
  options?: MemoryServiceOptions | IMemoryService
): Promise<{
  server: MuninnServer;
  transport: StdioServerTransport;
  service: IMemoryService;
}> {
  const service: IMemoryService = isMemoryService(options)
    ? options
    : new MemoryService(options);
  const server = createMcpServer(service);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return { server, transport, service };
}

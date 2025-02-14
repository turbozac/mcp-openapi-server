#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { OpenAPIV3 } from "openapi-types";
import axios from "axios";
import { readFile } from "fs/promises";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema, // Changed from ExecuteToolRequestSchema
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

interface OpenAPIMCPServerConfig {
  name: string;
  version: string;
  apiBaseUrl: string;
  openApiSpec: OpenAPIV3.Document | string;
  headers?: Record<string, string>;
  includeTags?: string[];
}

interface ResolvedSchema extends OpenAPIV3.SchemaObject {
  properties?: { [key: string]: OpenAPIV3.SchemaObject };
  items?: OpenAPIV3.SchemaObject;
}

function parseHeaders(headerStr?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (headerStr) {
    headerStr.split(",").forEach((header) => {
      const [key, value] = header.split(":");
      if (key && value) headers[key.trim()] = value.trim();
    });
  }
  return headers;
}

function parseIncludeTags(tags?: string): string[] | undefined {
  return tags ? tags.split(",").map((t) => t.trim()) : undefined;
}

function loadConfig(): OpenAPIMCPServerConfig {
  const argv = yargs(hideBin(process.argv))
    .option("api-base-url", {
      alias: "u",
      type: "string",
      description: "Base URL for the API",
    })
    .option("openapi-spec", {
      alias: "s",
      type: "string",
      description: "Path or URL to OpenAPI specification",
    })
    .option("headers", {
      alias: "H",
      type: "string",
      description: "API headers in format 'key1:value1,key2:value2'",
    })
    .option("tags", {
      alias: "t",
      type: "string",
      description: "Comma-separated list of OpenAPI tags to include",
    })
    .option("name", {
      alias: "n",
      type: "string",
      description: "Server name",
    })
    .option("version", {
      alias: "v",
      type: "string",
      description: "Server version",
    })
    .help().argv;

  // Combine CLI args and env vars, with CLI taking precedence
  const apiBaseUrl = argv["api-base-url"] || process.env.API_BASE_URL;
  const openApiSpec = argv["openapi-spec"] || process.env.OPENAPI_SPEC_PATH;

  if (!apiBaseUrl) {
    throw new Error(
      "API base URL is required (--api-base-url or API_BASE_URL)"
    );
  }
  if (!openApiSpec) {
    throw new Error(
      "OpenAPI spec is required (--openapi-spec or OPENAPI_SPEC_PATH)"
    );
  }

  const headers = parseHeaders(argv.headers || process.env.API_HEADERS);

  const tags = argv.tags || process.env.API_TAGS;
  const includeTags = parseIncludeTags(tags);

  return {
    name: argv.name || process.env.SERVER_NAME || "mcp-openapi-server",
    version: argv.version || process.env.SERVER_VERSION || "1.0.0",
    apiBaseUrl,
    openApiSpec,
    headers,
    includeTags,
  };
}

class OpenAPIMCPServer {
  private server: Server;
  private config: OpenAPIMCPServerConfig;

  private tools: Map<string, Tool> = new Map();

  constructor(config: OpenAPIMCPServerConfig) {
    this.config = config;
    this.server = new Server({
      name: config.name,
      version: config.version,
    });

    this.initializeHandlers();
  }

  private async loadOpenAPISpec(): Promise<OpenAPIV3.Document> {
    return await loadSpecFromSource(this.config.openApiSpec);
  }

  private async parseOpenAPISpec(): Promise<void> {
    console.error("Starting OpenAPI spec parsing...");
    const spec = await this.loadOpenAPISpec();
    console.error(`Loaded spec with ${Object.keys(spec.paths).length} paths`);

    logTagFiltering(this.config.includeTags);
    await this.processOpenAPIPaths(spec);
  }

  private async processOpenAPIPaths(spec: OpenAPIV3.Document): Promise<void> {
    const longEndpoints: string[] = [];

    for (const [path, pathItem] of Object.entries(spec.paths)) {
      if (!pathItem) continue;
      await this.processPathOperations(path, pathItem, longEndpoints, spec);
    }
  }

  private async processPathOperations(
    path: string,
    pathItem: OpenAPIV3.PathItemObject,
    longEndpoints: string[],
    spec: OpenAPIV3.Document
  ): Promise<void> {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (method === "parameters" || !operation) continue;

      const op = operation as OpenAPIV3.OperationObject;
      if (!shouldProcessOperation(op, this.config.includeTags)) continue;

      const { toolId, originalPath } = generateToolIdentifiers(
        path,
        method,
        longEndpoints
      );
      await this.registerTool(toolId, originalPath, method, op, spec);
    }
  }

  private async registerTool(
    toolId: string,
    originalPath: string,
    method: string,
    operation: OpenAPIV3.OperationObject,
    spec: OpenAPIV3.Document
  ): Promise<void> {
    const tool = createBaseTool(toolId, method, operation, originalPath);
    this.tools.set(toolId, tool);

    if (operation.parameters) {
      processOperationParameters(tool, operation.parameters, spec);
    }

    if (operation.requestBody) {
      processRequestBody(tool, operation.requestBody, spec);
    }
  }

  private initializeHandlers(): void {
    this.initializeListToolsHandler();
    this.initializeCallToolHandler();
  }

  private initializeListToolsHandler(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: Array.from(this.tools.values()),
    }));
  }

  private initializeCallToolHandler(): void {
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { id, name, arguments: params } = request.params;
      const cleanParams = cleanRequestParameters(params);

      const { tool, toolId } = await this.findTool(id, name);
      return await this.executeTool(tool, toolId, cleanParams);
    });
  }

  private async findTool(
    id?: string,
    name?: string
  ): Promise<{ tool: Tool; toolId: string }> {
    let tool: Tool | undefined;
    let toolId: string | undefined;

    if (id) {
      toolId = id.trim();
      tool = this.tools.get(toolId);
    } else if (name) {
      ({ tool, toolId } = findToolByName(name, this.tools));
    }

    if (!tool || !toolId) {
      throw new Error(generateToolNotFoundError(id || name, this.tools));
    }

    return { tool, toolId };
  }

  async start(): Promise<void> {
    await this.parseOpenAPISpec();
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("OpenAPI MCP Server running on stdio");
  }

  private async executeTool(
    tool: Tool,
    toolId: string,
    params: Record<string, any>
  ): Promise<any> {
    console.error(`Executing tool: ${toolId} (${tool.name})`);

    try {
      const method = tool.method;
      const path = tool.originalPath;
      const baseUrl = this.config.apiBaseUrl.endsWith("/")
        ? this.config.apiBaseUrl
        : `${this.config.apiBaseUrl}/`;
      const cleanPath = path.startsWith("/") ? path.slice(1) : path;
      const url = new URL(cleanPath, baseUrl).toString();

      const requestData = params.items ? params.items : params;

      const config = {
        method: method.toLowerCase(),
        url,
        headers: {
          "Content-Type": "application/json",
          ...this.config.headers,
        },
        ...(method.toLowerCase() === "get"
          ? { params: requestData }
          : { data: requestData }),
      };

      console.error("Final request config:", JSON.stringify(config, null, 2));

      const response = await axios(config);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response.data, null, 2),
          },
        ],
      };
    } catch (error) {
      handleToolExecutionError(error);
    }
  }
}

// Utility Functions

async function loadSpecFromSource(
  specSource: OpenAPIV3.Document | string
): Promise<OpenAPIV3.Document> {
  if (typeof specSource === "string") {
    if (specSource.startsWith("http")) {
      const response = await axios.get(specSource);
      return response.data as OpenAPIV3.Document;
    } else {
      const content = await readFile(specSource, "utf-8");
      return JSON.parse(content) as OpenAPIV3.Document;
    }
  }
  return specSource as OpenAPIV3.Document;
}

function shouldProcessOperation(
  operation: OpenAPIV3.OperationObject,
  includeTags?: string[]
): boolean {
  if (!includeTags || includeTags.length === 0) return true;

  const operationTags = operation.tags || [];

  // If operation has no tags and 'default' is in includeTags, include it
  if (operationTags.length === 0 && includeTags.includes("default")) {
    return true;
  }

  // Otherwise check if any of the operation's tags match includeTags
  return operationTags.some((tag) => includeTags.includes(tag));
}

function generateToolIdentifiers(
  path: string,
  method: string,
  longEndpoints: string[]
): { toolId: string; originalPath: string } {
  const cleanPath = path.replace(/^\//, "").replace(/[^a-zA-Z0-9-]/g, "-");
  let toolId = cleanPath;

  if (toolId.length > 64) {
    longEndpoints.push(
      `${method.toUpperCase()} ${path} (${toolId.length} chars)`
    );
    toolId = shortenToolId(toolId);
  }

  return { toolId, originalPath: path };
}

function shortenToolId(toolId: string): string {
  toolId = toolId.replace(/[aeiouAEIOU]/g, "");
  if (toolId.length > 64) {
    toolId = toolId.slice(0, 64);
  }
  return toolId;
}

function createBaseTool(
  toolId: string,
  method: string,
  operation: OpenAPIV3.OperationObject,
  originalPath: string
): Tool {
  return {
    name: toolId,
    description:
      operation.description ||
      `Make a ${method.toUpperCase()} request to ${originalPath}`,
    inputSchema: {
      type: "object",
      properties: {},
    },
    originalPath,
    method: method.toUpperCase(),
  };
}

function logTagFiltering(includeTags?: string[]): void {
  if (includeTags) {
    console.error(`Filtering for tags: ${includeTags.join(", ")}`);
  }
}

function findToolByName(
  name: string,
  tools: Map<string, Tool>
): { tool: Tool; toolId: string } | { tool: undefined; toolId: undefined } {
  for (const [tid, t] of tools.entries()) {
    if (t.name === name) {
      return { tool: t, toolId: tid };
    }
  }
  return { tool: undefined, toolId: undefined };
}

function generateToolNotFoundError(
  identifier: string,
  tools: Map<string, Tool>
): string {
  const availableTools = Array.from(tools.entries())
    .map(([id, t]) => `${id} (${t.name})`)
    .join(", ");
  return `Tool not found: ${identifier}\nAvailable tools: ${availableTools}`;
}

function cleanRequestParameters(
  params: Record<string, any>
): Record<string, any> {
  return Object.entries(params || {}).reduce((acc, [key, value]) => {
    try {
      if (
        typeof value === "string" &&
        (value.startsWith("[") || value.startsWith("{")) &&
        (value.endsWith("]") || value.endsWith("}"))
      ) {
        try {
          const cleanValue = value
            .replace(/`/g, "")
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, "\\");
          acc[key] = JSON.parse(cleanValue);
        } catch (parseError) {
          console.error(`Failed to parse JSON for ${key}:`, parseError);
          if (value.startsWith("[") && value.endsWith("]")) {
            const arrayContent = value.slice(1, -1).replace(/["\\\s]/g, "");
            acc[key] = arrayContent ? arrayContent.split(",") : [];
          } else {
            acc[key] = value;
          }
        }
      } else if (typeof value === "string") {
        acc[key] = value.replace(/`/g, "");
      } else {
        acc[key] = value;
      }
    } catch (e) {
      console.error(`Error processing parameter ${key}:`, e);
      acc[key] = value;
    }
    return acc;
  }, {} as Record<string, any>);
}

function resolveSchemaRef(
  ref: string,
  spec: OpenAPIV3.Document
): ResolvedSchema | undefined {
  const parts = ref.split("/").slice(1);
  let current: any = spec;

  for (const part of parts) {
    current = current[part];
    if (!current) return undefined;
  }

  // Convert the schema to a more MCP-friendly format
  const schema = current as ResolvedSchema;
  if (schema.properties) {
    const flattenedProperties: Record<string, OpenAPIV3.SchemaObject> = {};

    for (const [key, prop] of Object.entries(schema.properties)) {
      // Handle anyOf cases by taking the first non-null type
      if ("anyOf" in prop) {
        const nonNullType = (prop.anyOf as any[]).find(
          (t) => !("type" in t && t.type === "null")
        );
        if (nonNullType) {
          flattenedProperties[key] = {
            type: nonNullType.type,
            title: prop.title,
            description: `${prop.title || key} field`,
            ...(nonNullType.format ? { format: nonNullType.format } : {}),
          };

          // Add example values based on type
          if (nonNullType.type === "string") {
            if (nonNullType.format === "date-time") {
              flattenedProperties[key].example = new Date().toISOString();
            } else {
              flattenedProperties[key].example = `Example ${prop.title || key}`;
            }
          } else if (
            nonNullType.type === "number" ||
            nonNullType.type === "integer"
          ) {
            flattenedProperties[key].example = 0;
          } else if (nonNullType.type === "boolean") {
            flattenedProperties[key].example = false;
          }
        }
      } else {
        flattenedProperties[key] = prop;
      }
    }

    schema.properties = flattenedProperties;
  }

  return schema;
}

function processOperationParameters(
  tool: Tool,
  parameters: Array<OpenAPIV3.ParameterObject | OpenAPIV3.ReferenceObject>,
  spec: OpenAPIV3.Document
): void {
  for (const param of parameters) {
    if ("name" in param && "in" in param) {
      const paramSchema = param.schema as OpenAPIV3.SchemaObject;

      if (paramSchema.type === "array") {
        const items = paramSchema.items as OpenAPIV3.SchemaObject;
        if (items && "$ref" in items) {
          const resolvedItems = resolveSchemaRef(items.$ref, spec);

          if (resolvedItems) {
            paramSchema.items = resolvedItems;
          }
        }
      }

      const propertySchema: any = {
        type: paramSchema.type || "string",
        description: param.description || `${param.name} parameter`,
      };

      if (paramSchema.enum) {
        propertySchema.enum = paramSchema.enum;
      }

      if (paramSchema.type === "array") {
        console.error(paramSchema);
        propertySchema.type = "array";
        propertySchema.items = {
          type: (paramSchema.items as OpenAPIV3.SchemaObject)?.type || "string",
        };

        if (paramSchema.items && "enum" in paramSchema.items) {
          propertySchema.items.enum = paramSchema.items.enum;
        }

        if ((paramSchema.items as OpenAPIV3.SchemaObject)?.type === "object") {
          propertySchema.items = {
            type: "object",
            properties:
              (paramSchema.items as OpenAPIV3.SchemaObject).properties || {},
            required: (paramSchema.items as OpenAPIV3.SchemaObject).required,
            additionalProperties: true,
          };
        }
      }

      tool.inputSchema.properties[param.name] = propertySchema;

      if (param.required) {
        tool.inputSchema.required = tool.inputSchema.required || [];
        tool.inputSchema.required.push(param.name);
      }
    }
  }
}

function processRequestBody(
  tool: Tool,
  requestBody: OpenAPIV3.RequestBodyObject | OpenAPIV3.ReferenceObject,
  spec: OpenAPIV3.Document
): void {
  if ("content" in requestBody) {
    const content = requestBody.content["application/json"];

    if (content?.schema) {
      const bodySchema = content.schema as OpenAPIV3.SchemaObject;

      if (bodySchema.type === "array" && bodySchema.items) {
        if ("$ref" in bodySchema.items) {
          const resolvedItems = resolveSchemaRef(bodySchema.items.$ref, spec);

          if (resolvedItems) {
            tool.inputSchema = {
              type: "object",
              properties: {
                items: {
                  type: "array",
                  description: "Array of items to process",
                  items: {
                    type: "object",
                    properties: resolvedItems.properties,
                    ...(resolvedItems.required
                      ? { required: resolvedItems.required }
                      : {}),
                  },
                },
              },
              required: ["items"],
              ...(bodySchema.description
                ? { description: bodySchema.description }
                : {}),
            };
          }
        }
      } else if ("$ref" in bodySchema) {
        const resolvedSchema = resolveSchemaRef(bodySchema.$ref, spec);

        if (resolvedSchema) {
          tool.inputSchema = {
            type: "object",
            properties: resolvedSchema.properties || {},
            ...(resolvedSchema.required
              ? { required: resolvedSchema.required }
              : {}),
            ...(resolvedSchema.description
              ? { description: resolvedSchema.description }
              : {}),
            additionalProperties: false,
          };
        }
      }
    }
  }
}

function handleToolExecutionError(error: any): never {
  if (axios.isAxiosError(error)) {
    const errData = error.response?.data;
    const status = error.response?.status;
    const config = error.config;

    if (status === 422 && errData) {
      throw new Error(generateValidationErrorMessage(errData, config));
    } else if (status === 500) {
      throw new Error(
        "Something unexpected happened. If this issue continues, please contact support."
      );
    } else if (errData?.detail === "Not enough scopes for this endpoint") {
      throw new Error(
        "You are not allowed access. If you feel this is a mistake, please contact your system administrator."
      );
    } else {
      throw new Error(
        `API request failed (${status}): ${
          error.message
        }\nResponse: ${JSON.stringify(errData, null, 2)}`
      );
    }
  }
  throw error;
}

function generateValidationErrorMessage(errData: any, config: any): string {
  let errorMessage = "Validation Error:\n";

  console.error("Failed request details:");
  console.error(`URL: ${config?.url}`);
  console.error(`Method: ${config?.method?.toUpperCase()}`);
  console.error(`Request data:`, JSON.stringify(config?.data, null, 2));
  console.error(`Response:`, JSON.stringify(errData, null, 2));

  if (!errData.detail) {
    return errorMessage + "Unknown validation error occurred";
  }

  if (!Array.isArray(errData.detail)) {
    return errorMessage + errData.detail;
  }

  errData.detail.forEach((err: any) => {
    if (err.loc && err.loc.length > 0) {
      const locations = err.loc.slice(1);
      const locationPath = locations.join(" -> ");
      errorMessage += `\n- ${locationPath}: ${err.msg}`;
      if (err.type) {
        errorMessage += ` (expected type: ${err.type})`;
      }
      if (err.ctx) {
        errorMessage += `\n  Context: ${JSON.stringify(err.ctx)}`;
      }
    } else {
      errorMessage += `\n- ${err.msg}`;
    }
  });

  return errorMessage;
}

async function main(): Promise<void> {
  try {
    const config = loadConfig();
    const server = new OpenAPIMCPServer(config);
    await server.start();
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

main();

export { OpenAPIMCPServer, loadConfig };

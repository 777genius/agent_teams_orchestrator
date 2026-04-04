import { describe, expect, test } from 'bun:test'
import { AgentTool } from '../../tools/AgentTool/AgentTool.js'
import { BriefTool } from '../../tools/BriefTool/BriefTool.js'
import { MCPTool } from '../../tools/MCPTool/MCPTool.js'
import { CronCreateTool } from '../../tools/ScheduleCronTool/CronCreateTool.js'
import { TaskListTool } from '../../tools/TaskListTool/TaskListTool.js'
import { WebFetchTool } from '../../tools/WebFetchTool/WebFetchTool.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import { translateAnthropicBody } from './translation.js'

type JsonSchema = Record<string, unknown>

function translateToolSchema(inputSchema: JsonSchema): JsonSchema {
  const request = translateAnthropicBody({
    model: 'gemini-2.5-flash',
    messages: [],
    tools: [
      {
        name: 'test_tool',
        description: 'test tool',
        input_schema: inputSchema,
      },
    ],
  })

  const parameters = request.tools?.[0]?.functionDeclarations?.[0]?.parameters
  expect(parameters).toBeDefined()
  return parameters as JsonSchema
}

function expectNoDanglingRequired(schema: unknown, path: string = 'root'): void {
  if (!schema || typeof schema !== 'object') {
    return
  }

  const objectSchema = schema as JsonSchema
  const properties =
    objectSchema.properties && typeof objectSchema.properties === 'object'
      ? (objectSchema.properties as Record<string, unknown>)
      : null
  const required = Array.isArray(objectSchema.required)
    ? objectSchema.required
    : null

  if (required) {
    if (!properties) {
      throw new Error(`${path}: required present without properties`)
    }

    for (const field of required) {
      expect(typeof field).toBe('string')
      expect(properties).toHaveProperty(field as string)
    }
  }

  if (properties) {
    for (const [propertyName, propertySchema] of Object.entries(properties)) {
      expectNoDanglingRequired(propertySchema, `${path}.properties.${propertyName}`)
    }
  }

  if (objectSchema.items) {
    expectNoDanglingRequired(objectSchema.items, `${path}.items`)
  }

  if (objectSchema.defs && typeof objectSchema.defs === 'object') {
    for (const [definitionName, definitionSchema] of Object.entries(
      objectSchema.defs as Record<string, unknown>,
    )) {
      expectNoDanglingRequired(definitionSchema, `${path}.defs.${definitionName}`)
    }
  }

  if (Array.isArray(objectSchema.anyOf)) {
    for (const [index, variantSchema] of objectSchema.anyOf.entries()) {
      expectNoDanglingRequired(variantSchema, `${path}.anyOf[${index}]`)
    }
  }
}

describe('Gemini tool schema translation', () => {
  test('keeps AgentTool prompt and description properties aligned with required', () => {
    const parameters = translateToolSchema(zodToJsonSchema(AgentTool.inputSchema))

    expect(parameters.properties).toMatchObject({
      description: expect.any(Object),
      prompt: expect.any(Object),
    })
    expect(parameters.required).toContain('description')
    expect(parameters.required).toContain('prompt')
    expectNoDanglingRequired(parameters)
  })

  test('keeps WebFetchTool prompt and url properties aligned with required', () => {
    const parameters = translateToolSchema(
      zodToJsonSchema(WebFetchTool.inputSchema),
    )

    expect(parameters.properties).toMatchObject({
      url: expect.any(Object),
      prompt: expect.any(Object),
    })
    expect(parameters.required).toEqual(['url', 'prompt'])
    expectNoDanglingRequired(parameters)
  })

  test('keeps CronCreateTool prompt and cron properties aligned with required', () => {
    const parameters = translateToolSchema(
      zodToJsonSchema(CronCreateTool.inputSchema),
    )

    expect(parameters.properties).toMatchObject({
      cron: expect.any(Object),
      prompt: expect.any(Object),
    })
    expect(parameters.required).toEqual(['cron', 'prompt'])
    expectNoDanglingRequired(parameters)
  })

  test('handles nested BriefTool schemas without dangling required fields', () => {
    const parameters = translateToolSchema(zodToJsonSchema(BriefTool.inputSchema))

    expect(parameters.properties).toMatchObject({
      message: expect.any(Object),
      attachments: expect.any(Object),
      status: expect.any(Object),
    })
    expectNoDanglingRequired(parameters)
  })

  test('keeps empty object schema valid for TaskListTool', () => {
    const parameters = translateToolSchema(
      zodToJsonSchema(TaskListTool.inputSchema),
    )

    expect(parameters.type).toBe('object')
    expect(parameters.properties).toEqual({})
    expectNoDanglingRequired(parameters)
  })

  test('keeps open-world MCPTool schema valid', () => {
    const parameters = translateToolSchema(zodToJsonSchema(MCPTool.inputSchema))

    expect(parameters.type).toBe('object')
    expectNoDanglingRequired(parameters)
  })

  test('drops required if properties are absent in a malformed object schema', () => {
    const parameters = translateToolSchema({
      type: 'object',
      required: ['prompt'],
    })

    expect(parameters.required).toBeUndefined()
    expectNoDanglingRequired(parameters)
  })

  test('preserves top-level defs with valid required/properties alignment', () => {
    const parameters = translateToolSchema({
      type: 'object',
      properties: {
        task: {
          $ref: '#/$defs/taskInput',
        },
      },
      required: ['task'],
      $defs: {
        taskInput: {
          type: 'object',
          properties: {
            prompt: { type: 'string' },
            description: { type: 'string' },
          },
          required: ['prompt', 'description'],
        },
      },
    })

    expect(parameters.defs).toBeDefined()
    expect((parameters.properties as JsonSchema).task).toMatchObject({
      ref: '#/$defs/taskInput',
    })
    expectNoDanglingRequired(parameters)
  })

  test('keeps refs normalized to Gemini ref field', () => {
    const parameters = translateToolSchema({
      type: 'object',
      properties: {
        payload: {
          $ref: '#/$defs/payload',
        },
      },
      required: ['payload'],
      $defs: {
        payload: {
          type: 'object',
          properties: {
            prompt: { type: 'string' },
          },
          required: ['prompt'],
        },
      },
    })

    expect((parameters.properties as JsonSchema).payload).toEqual({
      ref: '#/$defs/payload',
    })
    expectNoDanglingRequired(parameters)
  })

  test('keeps required fields aligned inside array item object schemas', () => {
    const parameters = translateToolSchema({
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              prompt: { type: 'string' },
              status: { type: 'string' },
            },
            required: ['prompt', 'status'],
          },
        },
      },
      required: ['items'],
    })

    expect(parameters.properties).toMatchObject({
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            prompt: expect.any(Object),
            status: expect.any(Object),
          },
          required: ['prompt', 'status'],
        },
      },
    })
    expectNoDanglingRequired(parameters)
  })
})

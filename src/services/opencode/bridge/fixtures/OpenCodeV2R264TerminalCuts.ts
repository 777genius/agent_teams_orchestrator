import type { OpenCodeV2TurnCut } from '../../execution/OpenCodeV2TurnProjection.js'

/** Safe exact retained R264 native4 complete readbacks, preserving native cursors. */
export const capturedR264TerminalCuts: readonly OpenCodeV2TurnCut[] = [
  {
    "pin": "2.0.0",
    "sessionID": "ses_1dc4575ab2744b60b1e70f4d55da1a35",
    "nativeInputID": "msg_91406887f0544d57a8452a1f5b9a5634",
    "beforeCursor": 0,
    "originalText": "TEST-R239-original",
    "messages": {
      "data": [
        {
          "id": "msg_121118a39001d2E6gnlfiDZldv",
          "type": "assistant",
          "timeCreated": 1791556160120,
          "data": {
            "id": "msg_121118a39001d2E6gnlfiDZldv",
            "time": {
              "created": 1791556160120,
              "streamed": 1791556160135,
              "completed": 1791556160137
            },
            "type": "assistant",
            "agent": "TEST-agent",
            "model": {
              "id": "TEST-catalog",
              "providerID": "TEST-r239",
              "variant": "default"
            },
            "content": [
              {
                "type": "text",
                "text": "TEST-R239-completed"
              }
            ],
            "finish": "stop",
            "rawFinish": "stop",
            "cost": 0,
            "tokens": {
              "input": 10,
              "output": 2,
              "reasoning": 0,
              "cache": {
                "read": 0,
                "write": 0
              }
            }
          }
        },
        {
          "id": "msg_91406887f0544d57a8452a1f5b9a5634",
          "type": "user",
          "timeCreated": 1791556159991,
          "data": {
            "id": "msg_91406887f0544d57a8452a1f5b9a5634",
            "time": {
              "created": 1791556159991
            },
            "text": "TEST-R239-original",
            "type": "user"
          }
        }
      ],
      "previous": "eyJpZCI6Im1zZ18xMjExMThhMzkwMDFkMkU2Z25sZmlEWmxkdiIsIm9yZGVyIjoiZGVzYyIsImRpcmVjdGlvbiI6InByZXZpb3VzIn0",
      "next": "eyJpZCI6Im1zZ185MTQwNjg4N2YwNTQ0ZDU3YTg0NTJhMWY1YjlhNTYzNCIsIm9yZGVyIjoiZGVzYyIsImRpcmVjdGlvbiI6Im5leHQifQ"
    },
    "log": {
      "events": [
        {
          "id": "evt_121118994001CCtTC2KOVLpklR",
          "type": "session.created",
          "aggregateID": "ses_1dc4575ab2744b60b1e70f4d55da1a35",
          "seq": 0,
          "data": {
            "sessionID": "ses_1dc4575ab2744b60b1e70f4d55da1a35",
            "projectID": "5f56296ed0556b13786ebcdc6d72cda3f53c9d9f",
            "location": {
              "directory": "/srv/workers/jobs/agent-teams-ai/opencode-dual-20261001/workspaces/TEST-C41-r264-explicit-default-native-sdk-20261009/TEST-native-sdk-once/TEST-cases/TEST-2.0.0-complete"
            },
            "subpath": "",
            "slug": "playful-pixel",
            "title": "TEST-R239-native-SDK",
            "agent": "TEST-agent",
            "model": {
              "id": "TEST-catalog",
              "providerID": "TEST-r239",
              "variant": "default"
            },
            "version": "2.0.0"
          }
        },
        {
          "id": "evt_1211189d4001UE730WP0tPwAwi",
          "type": "session.inbox.enqueued",
          "aggregateID": "ses_1dc4575ab2744b60b1e70f4d55da1a35",
          "seq": 1,
          "data": {
            "sessionID": "ses_1dc4575ab2744b60b1e70f4d55da1a35",
            "inboxID": "msg_91406887f0544d57a8452a1f5b9a5634",
            "item": {
              "type": "user",
              "payload": {
                "text": "TEST-R239-original"
              },
              "delivery": "queue"
            }
          }
        },
        {
          "id": "evt_1211189dd001vEotBtroFP75zV",
          "type": "session.execution.started",
          "aggregateID": "ses_1dc4575ab2744b60b1e70f4d55da1a35",
          "seq": 2,
          "data": {
            "sessionID": "ses_1dc4575ab2744b60b1e70f4d55da1a35"
          }
        },
        {
          "id": "evt_1211189f2001CPrkYKymmtk7iB",
          "type": "session.instructions.updated",
          "aggregateID": "ses_1dc4575ab2744b60b1e70f4d55da1a35",
          "seq": 3,
          "data": {
            "sessionID": "ses_1dc4575ab2744b60b1e70f4d55da1a35",
            "delta": {
              "core/environment": "9a56920fd339bc0ca4df4a3f35282b25866add066887424ae14bea914e3bcc15",
              "core/date": "2695d4ea164b6405c0d8280542313e7c7febfc75fdbebe5804d53d4bd91426c0"
            }
          }
        },
        {
          "id": "evt_1211189f7001f96vdirvzIxfAA",
          "type": "session.inbox.delivered",
          "aggregateID": "ses_1dc4575ab2744b60b1e70f4d55da1a35",
          "seq": 4,
          "data": {
            "sessionID": "ses_1dc4575ab2744b60b1e70f4d55da1a35",
            "inboxID": "msg_91406887f0544d57a8452a1f5b9a5634"
          }
        },
        {
          "id": "evt_121118a780018hajUPwn84Dad5",
          "type": "session.step.started",
          "aggregateID": "ses_1dc4575ab2744b60b1e70f4d55da1a35",
          "seq": 5,
          "data": {
            "sessionID": "ses_1dc4575ab2744b60b1e70f4d55da1a35",
            "assistantMessageID": "msg_121118a39001d2E6gnlfiDZldv",
            "agent": "TEST-agent",
            "model": {
              "id": "TEST-catalog",
              "providerID": "TEST-r239",
              "variant": "default"
            }
          }
        },
        {
          "id": "evt_121118a7c001ZHI7iPfuEW4AfP",
          "type": "session.text.started",
          "aggregateID": "ses_1dc4575ab2744b60b1e70f4d55da1a35",
          "seq": 6,
          "data": {
            "sessionID": "ses_1dc4575ab2744b60b1e70f4d55da1a35",
            "assistantMessageID": "msg_121118a39001d2E6gnlfiDZldv",
            "ordinal": 0
          }
        },
        {
          "id": "evt_121118a83001vmvOjQN3Tp9f2T",
          "type": "session.text.ended",
          "aggregateID": "ses_1dc4575ab2744b60b1e70f4d55da1a35",
          "seq": 7,
          "data": {
            "sessionID": "ses_1dc4575ab2744b60b1e70f4d55da1a35",
            "assistantMessageID": "msg_121118a39001d2E6gnlfiDZldv",
            "ordinal": 0,
            "text": "TEST-R239-completed"
          }
        },
        {
          "id": "evt_121118a87001EPkmr6XhsnBg1t",
          "type": "session.step.streamed",
          "aggregateID": "ses_1dc4575ab2744b60b1e70f4d55da1a35",
          "seq": 8,
          "data": {
            "sessionID": "ses_1dc4575ab2744b60b1e70f4d55da1a35",
            "assistantMessageID": "msg_121118a39001d2E6gnlfiDZldv"
          }
        },
        {
          "id": "evt_121118a89001TiMPfSKeZ9VEo1",
          "type": "session.step.ended",
          "aggregateID": "ses_1dc4575ab2744b60b1e70f4d55da1a35",
          "seq": 9,
          "data": {
            "sessionID": "ses_1dc4575ab2744b60b1e70f4d55da1a35",
            "assistantMessageID": "msg_121118a39001d2E6gnlfiDZldv",
            "finish": "stop",
            "rawFinish": "stop",
            "cost": 0,
            "tokens": {
              "input": 10,
              "output": 2,
              "reasoning": 0,
              "cache": {
                "read": 0,
                "write": 0
              }
            }
          }
        },
        {
          "id": "evt_121118a8d0018Xo8uDELctr6u8",
          "type": "session.execution.succeeded",
          "aggregateID": "ses_1dc4575ab2744b60b1e70f4d55da1a35",
          "seq": 10,
          "data": {
            "sessionID": "ses_1dc4575ab2744b60b1e70f4d55da1a35"
          }
        }
      ],
      "synced": true,
      "watermark": 10
    }
  },
  {
    "pin": "2.0.21",
    "sessionID": "ses_0c9af7ac2fa44fa197fc257175816c1f",
    "nativeInputID": "msg_bfe545b5bfb24b599ecc26687b5b745c",
    "beforeCursor": 0,
    "originalText": "TEST-R239-original",
    "messages": {
      "data": [
        {
          "id": "msg_12111bd220017yGLnoRyjWJ8E2",
          "type": "idle",
          "timeCreated": 1791556173090,
          "data": {
            "id": "msg_12111bd220017yGLnoRyjWJ8E2",
            "time": {
              "created": 1791556173090
            },
            "type": "idle",
            "outcome": "succeeded"
          }
        },
        {
          "id": "msg_12111bcd1001fazIAeIpljVsJD",
          "type": "assistant",
          "timeCreated": 1791556173031,
          "data": {
            "id": "msg_12111bcd1001fazIAeIpljVsJD",
            "time": {
              "created": 1791556173031,
              "streamed": 1791556173080,
              "completed": 1791556173084
            },
            "type": "assistant",
            "agent": "TEST-agent",
            "model": {
              "id": "TEST-catalog",
              "providerID": "TEST-r239",
              "variant": "default"
            },
            "content": [
              {
                "type": "text",
                "text": "TEST-R239-completed"
              }
            ],
            "finish": "stop",
            "rawFinish": "stop",
            "cost": 0,
            "tokens": {
              "input": 10,
              "output": 2,
              "reasoning": 0,
              "cache": {
                "read": 0,
                "write": 0
              }
            }
          }
        },
        {
          "id": "msg_bfe545b5bfb24b599ecc26687b5b745c",
          "type": "user",
          "timeCreated": 1791556172973,
          "data": {
            "id": "msg_bfe545b5bfb24b599ecc26687b5b745c",
            "time": {
              "created": 1791556172973
            },
            "text": "TEST-R239-original",
            "type": "user"
          }
        }
      ],
      "previous": "eyJpZCI6Im1zZ18xMjExMWJkMjIwMDE3eUdMbm9SeWpXSjhFMiIsIm9yZGVyIjoiZGVzYyIsImRpcmVjdGlvbiI6InByZXZpb3VzIn0",
      "next": "eyJpZCI6Im1zZ19iZmU1NDViNWJmYjI0YjU5OWVjYzI2Njg3YjViNzQ1YyIsIm9yZGVyIjoiZGVzYyIsImRpcmVjdGlvbiI6Im5leHQifQ"
    },
    "log": {
      "events": [
        {
          "id": "evt_12111bc32001z0cvZHzhRj1qJA",
          "type": "session.created",
          "aggregateID": "ses_0c9af7ac2fa44fa197fc257175816c1f",
          "seq": 0,
          "data": {
            "sessionID": "ses_0c9af7ac2fa44fa197fc257175816c1f",
            "projectID": "5b6e2cb6bec2caed56ffad969a30c94281f8f0d0",
            "location": {
              "directory": "/srv/workers/jobs/agent-teams-ai/opencode-dual-20261001/workspaces/TEST-C41-r264-explicit-default-native-sdk-20261009/TEST-native-sdk-once/TEST-cases/TEST-2.0.21-complete"
            },
            "subpath": "",
            "slug": "clever-engine",
            "title": "TEST-R239-native-SDK",
            "agent": "TEST-agent",
            "model": {
              "id": "TEST-catalog",
              "providerID": "TEST-r239",
              "variant": "default"
            },
            "version": "2.0.21"
          }
        },
        {
          "id": "evt_12111bc98001ADlqCqtZzBbnKn",
          "type": "session.inbox.enqueued",
          "aggregateID": "ses_0c9af7ac2fa44fa197fc257175816c1f",
          "seq": 1,
          "data": {
            "sessionID": "ses_0c9af7ac2fa44fa197fc257175816c1f",
            "inboxID": "msg_bfe545b5bfb24b599ecc26687b5b745c",
            "item": {
              "type": "user",
              "payload": {
                "text": "TEST-R239-original"
              },
              "delivery": "queue"
            }
          }
        },
        {
          "id": "evt_12111bc9d001gMthGHsPT78Xm1",
          "type": "session.execution.started",
          "aggregateID": "ses_0c9af7ac2fa44fa197fc257175816c1f",
          "seq": 2,
          "data": {
            "sessionID": "ses_0c9af7ac2fa44fa197fc257175816c1f"
          }
        },
        {
          "id": "evt_12111bca9001wzZ6FLGizGim39",
          "type": "session.instructions.updated",
          "aggregateID": "ses_0c9af7ac2fa44fa197fc257175816c1f",
          "seq": 3,
          "data": {
            "sessionID": "ses_0c9af7ac2fa44fa197fc257175816c1f",
            "delta": {
              "core/date": "2695d4ea164b6405c0d8280542313e7c7febfc75fdbebe5804d53d4bd91426c0",
              "core/environment": "87d5a072233d900e9d41a5a3c8b8e345b22ad39419c2cc6c5e08b7b5a80d2527"
            }
          }
        },
        {
          "id": "evt_12111bcad001IraUV1V1FlO2hy",
          "type": "session.inbox.delivered",
          "aggregateID": "ses_0c9af7ac2fa44fa197fc257175816c1f",
          "seq": 4,
          "data": {
            "sessionID": "ses_0c9af7ac2fa44fa197fc257175816c1f",
            "inboxID": "msg_bfe545b5bfb24b599ecc26687b5b745c"
          }
        },
        {
          "id": "evt_12111bd05001M8unonwh6tu7F4",
          "type": "session.step.started",
          "aggregateID": "ses_0c9af7ac2fa44fa197fc257175816c1f",
          "seq": 5,
          "data": {
            "sessionID": "ses_0c9af7ac2fa44fa197fc257175816c1f",
            "assistantMessageID": "msg_12111bcd1001fazIAeIpljVsJD",
            "agent": "TEST-agent",
            "model": {
              "id": "TEST-catalog",
              "providerID": "TEST-r239",
              "variant": "default"
            },
            "started": 1791556173031
          }
        },
        {
          "id": "evt_12111bd09001Eitk6WJSBl5XuR",
          "type": "session.text.started",
          "aggregateID": "ses_0c9af7ac2fa44fa197fc257175816c1f",
          "seq": 6,
          "data": {
            "sessionID": "ses_0c9af7ac2fa44fa197fc257175816c1f",
            "assistantMessageID": "msg_12111bcd1001fazIAeIpljVsJD",
            "ordinal": 0
          }
        },
        {
          "id": "evt_12111bd13001oHntZAZe0sWRQC",
          "type": "session.text.ended",
          "aggregateID": "ses_0c9af7ac2fa44fa197fc257175816c1f",
          "seq": 7,
          "data": {
            "sessionID": "ses_0c9af7ac2fa44fa197fc257175816c1f",
            "assistantMessageID": "msg_12111bcd1001fazIAeIpljVsJD",
            "ordinal": 0,
            "text": "TEST-R239-completed"
          }
        },
        {
          "id": "evt_12111bd18001b00oxQTWWSB5fl",
          "type": "session.step.streamed",
          "aggregateID": "ses_0c9af7ac2fa44fa197fc257175816c1f",
          "seq": 8,
          "data": {
            "sessionID": "ses_0c9af7ac2fa44fa197fc257175816c1f",
            "assistantMessageID": "msg_12111bcd1001fazIAeIpljVsJD"
          }
        },
        {
          "id": "evt_12111bd1c001RU5jWeGUPJsjNx",
          "type": "session.step.ended",
          "aggregateID": "ses_0c9af7ac2fa44fa197fc257175816c1f",
          "seq": 9,
          "data": {
            "sessionID": "ses_0c9af7ac2fa44fa197fc257175816c1f",
            "assistantMessageID": "msg_12111bcd1001fazIAeIpljVsJD",
            "finish": "stop",
            "rawFinish": "stop",
            "cost": 0,
            "tokens": {
              "input": 10,
              "output": 2,
              "reasoning": 0,
              "cache": {
                "read": 0,
                "write": 0
              }
            }
          }
        },
        {
          "id": "evt_12111bd220017yGLnoRyjWJ8E2",
          "type": "session.execution.succeeded",
          "aggregateID": "ses_0c9af7ac2fa44fa197fc257175816c1f",
          "seq": 10,
          "data": {
            "sessionID": "ses_0c9af7ac2fa44fa197fc257175816c1f"
          }
        }
      ],
      "synced": true,
      "watermark": 10
    }
  }
]

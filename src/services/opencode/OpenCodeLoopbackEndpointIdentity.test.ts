import { describe, expect, test } from 'bun:test'

import {
  captureOpenCodeLoopbackEndpointIdentity,
  listenerInode,
} from './OpenCodeLoopbackEndpointIdentity.js'

const header = 'sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode'
const listener = '0: 0100007F:1000 00000000:0000 0A 0:0 00:0 0 1000 0 424242'

describe('OpenCodeLoopbackEndpointIdentity', () => {
  test('selects one exact IPv4 loopback listener', () => {
    expect(listenerInode(`${header}\n${listener}\n`, 4096)).toBe('424242')
    expect(listenerInode(`${header}\n${listener}\n${listener}\n`, 4096)).toBeNull()
    expect(listenerInode(`${header}\n${listener.replace('0100007F', '00000000')}\n`, 4096)).toBeNull()
  })

  test('binds the listener inode to the exact PID and stable start identity', async () => {
    const starts = [`start_${'a'.repeat(64)}`, `start_${'a'.repeat(64)}`]
    const identity = await captureOpenCodeLoopbackEndpointIdentity(
      91,
      4096,
      async pid => ({ pid, startIdentity: starts.shift()! }),
      {
        readTcpTable: async () => `${header}\n${listener}\n`,
        readProcessDescriptors: async pid => pid === 91 ? ['3', '4'] : [],
        readDescriptorLink: async (_pid, descriptor) => descriptor === '4' ? 'socket:[424242]' : null,
      },
    )
    expect(identity).toEqual({
      address: '127.0.0.1', port: 4096, pid: 91, startIdentity: `start_${'a'.repeat(64)}`,
    })
  })

  test('rejects listener substitution and PID reuse', async () => {
    const io = {
      readTcpTable: async () => `${header}\n${listener}\n`,
      readProcessDescriptors: async () => ['3'],
      readDescriptorLink: async () => 'socket:[999999]',
    }
    expect(await captureOpenCodeLoopbackEndpointIdentity(
      91, 4096, async pid => ({ pid, startIdentity: `start_${'a'.repeat(64)}` }), io,
    )).toBeNull()
    io.readDescriptorLink = async () => 'socket:[424242]'
    let call = 0
    expect(await captureOpenCodeLoopbackEndpointIdentity(
      91, 4096, async pid => ({ pid, startIdentity: `start_${(++call).toString().repeat(64).slice(0, 64)}` }), io,
    )).toBeNull()
  })
})

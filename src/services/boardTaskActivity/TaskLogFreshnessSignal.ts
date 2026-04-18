import { mkdir, writeFile } from 'fs/promises'
import { basename, join, relative, sep } from 'path'

import { type Entry } from '../../types/logs.js'
import { getProjectsDir } from '../../utils/sessionStoragePortable.js'

export const BOARD_TASK_LOG_FRESHNESS_DIRNAME = '.board-task-log-freshness'
const BOARD_TASK_LOG_FRESHNESS_FILE_SUFFIX = '.json'

function asCanonicalTaskId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function collectCanonicalTaskIdsFromEntry(entry: Entry): string[] {
  if (!('boardTaskLinks' in entry) || !Array.isArray(entry.boardTaskLinks)) {
    return []
  }

  const taskIds = new Set<string>()
  for (const link of entry.boardTaskLinks) {
    const canonicalId =
      asCanonicalTaskId(link?.task?.canonicalId) ??
      (link?.task?.refKind === 'canonical' ? asCanonicalTaskId(link?.task?.ref) : null)
    if (canonicalId) {
      taskIds.add(canonicalId)
    }
  }
  return [...taskIds]
}

export function collectBoardTaskCanonicalIdsFromEntries(entries: readonly Entry[]): string[] {
  const taskIds = new Set<string>()
  for (const entry of entries) {
    for (const taskId of collectCanonicalTaskIdsFromEntry(entry)) {
      taskIds.add(taskId)
    }
  }
  return [...taskIds]
}

export function getBoardTaskLogFreshnessDir(projectDir: string): string {
  return join(projectDir, BOARD_TASK_LOG_FRESHNESS_DIRNAME)
}

export function encodeBoardTaskLogFreshnessTaskId(taskId: string): string {
  return encodeURIComponent(taskId)
}

export function decodeBoardTaskLogFreshnessTaskId(fileName: string): string | null {
  if (!fileName.endsWith(BOARD_TASK_LOG_FRESHNESS_FILE_SUFFIX)) {
    return null
  }
  const encodedTaskId = fileName.slice(0, -BOARD_TASK_LOG_FRESHNESS_FILE_SUFFIX.length)
  if (!encodedTaskId) {
    return null
  }
  try {
    const decodedTaskId = decodeURIComponent(encodedTaskId)
    return decodedTaskId.trim().length > 0 ? decodedTaskId : null
  } catch {
    return null
  }
}

export function getBoardTaskLogFreshnessSignalFilePath(
  projectDir: string,
  taskId: string,
): string {
  return join(
    getBoardTaskLogFreshnessDir(projectDir),
    `${encodeBoardTaskLogFreshnessTaskId(taskId)}${BOARD_TASK_LOG_FRESHNESS_FILE_SUFFIX}`,
  )
}

export function deriveBoardTaskLogFreshnessProjectDirFromTranscriptPath(
  transcriptPath: string,
  projectsDir: string = getProjectsDir(),
): string | null {
  const relativePath = relative(projectsDir, transcriptPath)
  if (
    !relativePath ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath === '..' ||
    relativePath.startsWith('..')
  ) {
    return null
  }

  const [projectId] = relativePath.split(sep)
  if (!projectId) {
    return null
  }
  return join(projectsDir, projectId)
}

export async function touchBoardTaskLogFreshnessSignals(params: {
  transcriptPath: string
  entries: readonly Entry[]
}): Promise<void> {
  const taskIds = collectBoardTaskCanonicalIdsFromEntries(params.entries)
  if (taskIds.length === 0) {
    return
  }

  const projectDir = deriveBoardTaskLogFreshnessProjectDirFromTranscriptPath(
    params.transcriptPath,
  )
  if (!projectDir) {
    return
  }

  const freshnessDir = getBoardTaskLogFreshnessDir(projectDir)
  await mkdir(freshnessDir, { recursive: true, mode: 0o700 })

  const updatedAt = new Date().toISOString()
  await Promise.all(
    taskIds.map(taskId =>
      writeFile(
        getBoardTaskLogFreshnessSignalFilePath(projectDir, taskId),
        JSON.stringify({
          taskId,
          updatedAt,
          transcriptFile: basename(params.transcriptPath),
        }),
        { encoding: 'utf8', mode: 0o600 },
      ),
    ),
  )
}

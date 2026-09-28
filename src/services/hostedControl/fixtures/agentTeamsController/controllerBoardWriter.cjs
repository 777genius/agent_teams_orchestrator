// Agent-style task update through the verbatim controller lock (agent-teams-ai
// agent-teams-controller/src/internal/fileLock.js @ b3fba1176b): read, pause, write.
const fs = require('fs');
const path = require('path');
const { withFileLockSync } = require('./fileLock.js');

const [teamDirectory, taskFile, pauseMs] = process.argv.slice(2);
withFileLockSync(path.join(teamDirectory, 'board-state'), () => {
  const task = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
  process.stdout.write(`locked ${Date.now()}\n`);
  const until = Date.now() + Number(pauseMs);
  while (Date.now() < until) {
    // Hold the board lock between the read and the write, like a slow agent tool.
  }
  fs.writeFileSync(taskFile, JSON.stringify({ ...task, status: 'in_progress' }));
});

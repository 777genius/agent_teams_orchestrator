// Verbatim from agent-teams-ai agent-teams-controller/src/internal/taskOwnershipGuards.js @ ef811a1b3c:
// the owner comparison task_start, task_complete and task_set_owner apply for agents.
function normalizeActorName(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function isSameTaskMember(left, right, leadName) {
    const normalizedLeft = normalizeActorName(left).toLowerCase();
    const normalizedRight = normalizeActorName(right).toLowerCase();
    const normalizedLead = normalizeActorName(leadName).toLowerCase();
    if (!normalizedLeft || !normalizedRight) {
        return false;
    }
    if (normalizedLeft === normalizedRight) {
        return true;
    }
    return (
        (normalizedLeft === 'team-lead' && normalizedRight === normalizedLead) ||
        (normalizedRight === 'team-lead' && normalizedLeft === normalizedLead)
    );
}

module.exports = { isSameTaskMember };

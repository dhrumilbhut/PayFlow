/**
 * Payment State Machine
 *
 * The state machine is the source of truth for what transitions are allowed.
 * Every status update in the system must call canTransition() before executing.
 *
 * Why centralize this?
 * - Prevents invalid state transitions anywhere in the codebase
 * - Makes the business rules explicit and readable
 * - Easier to audit: one file tells you all possible flows
 * - Terminal states (SUCCESS, FAILED) can never be overwritten accidentally
 *
 * External states (visible via API): PENDING, PROCESSING, SUCCESS, FAILED
 * Internal state: RETRY_SCHEDULED (hidden from API consumers)
 */

const STATES = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  RETRY_SCHEDULED: 'RETRY_SCHEDULED',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
};

// Adjacency list: from state → allowed next states
const TRANSITIONS = {
  [STATES.PENDING]: [STATES.PROCESSING],
  [STATES.PROCESSING]: [STATES.SUCCESS, STATES.RETRY_SCHEDULED, STATES.FAILED],
  [STATES.RETRY_SCHEDULED]: [STATES.PROCESSING],
  [STATES.SUCCESS]: [], // terminal — no further transitions
  [STATES.FAILED]: [],  // terminal — no further transitions
};

// External states are what API consumers see
// RETRY_SCHEDULED maps to PROCESSING so consumers see a clean lifecycle
const EXTERNAL_STATE_MAP = {
  [STATES.PENDING]: 'PENDING',
  [STATES.PROCESSING]: 'PROCESSING',
  [STATES.RETRY_SCHEDULED]: 'PROCESSING',
  [STATES.SUCCESS]: 'SUCCESS',
  [STATES.FAILED]: 'FAILED',
};

/**
 * Returns true if transitioning from currentState to nextState is allowed.
 */
function canTransition(currentState, nextState) {
  const allowed = TRANSITIONS[currentState];
  if (!allowed) return false;
  return allowed.includes(nextState);
}

/**
 * Throws if the transition is not allowed. Use this in write paths.
 */
function assertTransition(currentState, nextState) {
  if (!canTransition(currentState, nextState)) {
    const err = new Error(
      `Invalid state transition: ${currentState} → ${nextState}`
    );
    err.code = 'INVALID_STATE_TRANSITION';
    err.currentState = currentState;
    err.nextState = nextState;
    throw err;
  }
}

/**
 * Returns true if a state is terminal (no further transitions possible).
 */
function isTerminal(state) {
  return TRANSITIONS[state]?.length === 0;
}

/**
 * Map internal state to external (API-visible) state.
 */
function toExternalState(internalState) {
  return EXTERNAL_STATE_MAP[internalState] || internalState;
}

module.exports = { STATES, TRANSITIONS, canTransition, assertTransition, isTerminal, toExternalState };

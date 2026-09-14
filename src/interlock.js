// interlock.js — decides WHO completes a drop.
//
// The same hand can pass through two cameras (phone grabs, then opens the fist
// over the laptop). Only one end should decide "send now":
//   - receiver HAS a camera -> the laptop sees fist->palm and sends {t:'drop'}
//   - receiver has NO camera -> the sender's own release sends immediately
//
// Pure state machines (no DOM, no timers) so node can test every transition.

export const DROP_WINDOW_MS = 1600;   // how long the sender holds after ITS release
export const ACK_TIMEOUT_MS = 5000;   // lose-ack backstop for the sender

// —— SENDER -----------------------------------------------------------------
// idle ->(grab)-> holding ->(ownRelease, no camera)-> sending
//                       ->(ownRelease, camera) -> waitingDrop ->(drop)-> sending
//                                                      ->(cancel after window)-> idle
// sending ->(ack)-> idle
// sending ->(ackLost)-> idle   (no confirmation from the laptop — honest failure)

export function createSenderInterlock({ onSend, onWaitDropStart, onCancel, onDone, onLostAck } = {}) {
  let state = 'idle';            // idle | holding | waitingDrop | sending
  let hold = null;
  let flying = null;
  let receiverCamera = false;
  let waitNotified = false;

  return {
    get state() { return state; },
    get holding() { return hold; },
    setReceiver({ camera } = {}) { receiverCamera = !!camera; },

    grab(payload) {
      if (state !== 'idle') return false;
      hold = payload;
      state = 'holding';
      return true;
    },

    abort() {
      if (state !== 'holding' && state !== 'waitingDrop') return null;
      state = 'idle';
      const p = hold;
      hold = null;
      waitNotified = false;
      return p;
    },

    ownRelease() {
      if (state === 'idle') return;
      if (state === 'sending') return;        // already flying, ignore
      if (state === 'waitingDrop') return;    // already waiting for the laptop, keep quiet
      if (receiverCamera) {
        state = 'waitingDrop';
        if (waitNotified) return;
        waitNotified = true;
        onWaitDropStart?.();
      } else {
        this._send();
      }
    },

    dropFromReceiver() {
      if (state === 'idle') return 'nothing';
      if (state === 'sending') return 'sent'; // a drop for an already-flying transfer
      this._send();
      return 'sent';
    },

    cancel() {
      if (state !== 'waitingDrop') return;
      state = 'idle';
      const p = hold;
      hold = null;
      waitNotified = false;
      onCancel?.(p);
    },

    _send() {
      if (state !== 'holding' && state !== 'waitingDrop') return;
      state = 'sending';
      const p = hold;
      hold = null;
      flying = p;
      waitNotified = false;
      onSend?.(p);
    },

    ack() {
      if (state !== 'sending') return;
      state = 'idle';
      const p = flying;
      flying = null;
      onDone?.(p);
    },

    ackLost() {
      if (state !== 'sending') return;
      state = 'idle';
      const p = flying;
      flying = null;
      onLostAck?.(p);
    },
  };
}

// —— RECEIVER ---------------------------------------------------------------
// idle ->(holding msg)-> holding ->(fist->open sensed)-> waiting ->(transfer done)-> idle
//
// holding	the sender told us a grab is in flight (preview ghost shows)
// requestDrop	our camera saw the open fist (or an open palm while a grab is
//              in flight): send the drop request. Returns 'drop' if it moved
//              holding->waiting, 're-drop' if we were already waiting (the user
//              opened the palm again — remind the sender), 'nothing' if idle
//              (the grab hadn't arrived yet — the page latches a pending drop).
// done		transfer landed: back to idle

export function createReceiverInterlock({ onHolding, onDrop, onDone } = {}) {
  let state = 'idle';   // idle | holding | waiting
  let held = null;

  return {
    get state() { return state; },
    get held() { return held; },

    holding(payload) {
      if (state !== 'idle') return;
      held = payload;
      state = 'holding';
      onHolding?.(payload);
    },

    requestDrop() {
      if (state === 'holding') {
        state = 'waiting';
        const p = held;
        onDrop?.(p);
        return 'drop';
      }
      if (state === 'waiting') {
        const p = held;
        onDrop?.(p);
        return 're-drop';
      }
      return 'nothing';
    },

    done() {
      state = 'idle';
      held = null;
      onDone?.();
    },
  };
}
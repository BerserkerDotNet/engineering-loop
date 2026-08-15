/**
 * One-shot listening gate shared by extension startup and canvas rehydration.
 * A server object is not published until start() has assigned a usable port.
 */
export function createListeningGate() {
  let value = null;
  let failure = null;
  let settled = false;
  let release;
  const ready = new Promise((resolve) => {
    release = resolve;
  });

  return {
    publish(server) {
      if (settled) return;
      if (!server || !Number.isInteger(server.port) || server.port <= 0) {
        throw new Error("a loopback server cannot be published before it is listening");
      }
      settled = true;
      value = server;
      release();
    },

    fail(error) {
      if (settled) return;
      settled = true;
      failure = error instanceof Error ? error : new Error(String(error));
      release();
    },

    async wait(timeoutMs) {
      if (!settled) {
        let timer = null;
        const timeout = new Promise((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
          if (typeof timer.unref === "function") timer.unref();
        });
        try {
          await Promise.race([ready, timeout]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      if (failure) throw failure;
      return value;
    },

    get current() {
      return value;
    },
  };
}

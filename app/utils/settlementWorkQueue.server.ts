export type SettlementPriority = { background: boolean };
/** Shopifyの同時実行数を増やさず、画面の集計をバックグラウンドより優先する。 */
export function createSettlementWorkQueue({ graceMs = 1500, maxInteractiveBurst = 8 } = {}) {
  type Task = { priority: SettlementPriority; start: () => void };
  type State = { running: boolean; tasks: Task[]; lastInteractiveEnd: number; burst: number; timer?: ReturnType<typeof setTimeout> };
  const shops = new Map<string, State>();
  function next(shop: string, state: State) {
    if (state.running) return;
    if (state.timer) { clearTimeout(state.timer); state.timer = undefined; }
    const remaining = state.lastInteractiveEnd + graceMs - Date.now();
    if (!state.tasks.length) {
      // 続く画面の店舗集計の間は優先枠を保ち、その後はショップの状態を解放する。
      if (remaining > 0) state.timer = setTimeout(() => next(shop, state), remaining);
      else shops.delete(shop);
      state.timer?.unref?.();
      return;
    }
    let index = state.tasks.findIndex(task => !task.priority.background);
    const backgroundIndex = state.tasks.findIndex(task => task.priority.background);
    // 画面が連続しても裏の更新を永久に止めない。
    if (backgroundIndex >= 0 && state.burst >= maxInteractiveBurst) index = backgroundIndex;
    if (index < 0) {
      if (remaining > 0) { state.timer = setTimeout(() => next(shop, state), remaining); return; }
      index = 0;
    }
    const [task] = state.tasks.splice(index, 1);
    state.running = true;
    state.burst = task.priority.background ? 0 : state.burst + 1;
    task.start();
  }
  return {
    run<T>(shop: string, classification: boolean | SettlementPriority, fn: () => Promise<T>): Promise<T> {
      const priority = typeof classification === "boolean" ? {background: classification} : classification;
      let state = shops.get(shop);
      if (!state) { state = { running: false, tasks: [], lastInteractiveEnd: 0, burst: 0 }; shops.set(shop, state); }
      const current = state;
      return new Promise<T>((resolve, reject) => {
        current.tasks.push({ priority, start: () => {
          Promise.resolve().then(fn).then(resolve, reject).finally(() => {
            current.running = false;
            if (!priority.background) current.lastInteractiveEnd = Date.now();
            next(shop, current);
          });
        }});
        next(shop, current);
      });
    },
    promote(priority: SettlementPriority) {
      priority.background = false;
      for (const [shop, state] of shops) {
        if (state.tasks.some(task => task.priority === priority)) next(shop, state);
      }
    },
    size() { return shops.size; },
  };
}

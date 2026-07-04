# 013-implement — Map 层内存图维护

1. `src/flow-map/graph-doc.ts`：MapGraphDoc + ensure/apply/toSnapshot/buildResumePatch
2. 重写 `electron-ipc` adapter：graphs 取代 lastRun/meta/pending
3. export；vue-tsc + test:map

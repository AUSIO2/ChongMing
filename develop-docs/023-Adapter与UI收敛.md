# Adapter 与 UI 收敛

## 背景

阶段 1 完成 Map 投影单源后，Adapter 与 UI 仍存在样板重复、双 refresh、标签分散。

## 目标（阶段 2）

1. `adapterMutate` 收敛 ensure → mutate → persist → snapshot
2. `docReadInstanceIds` / `docReadRoutes` 下沉图语义
3. `resetSession` + `onUpdated` 上提 HomeView，mutation 不二次 refresh
4. `labels.ts` 集中节点/阶段标签

## 目标（阶段 4）

1. `GraphClaim` DTO alias
2. `fitToView` 实现
3. `unloadNews` 图缓存释放
4. `SubAgentCatalogPicker` 组件提取
5. `storeReadError` 统一错误面

## 验收

`npm run test:map` + `vue-tsc --noEmit`

# implement：Map 投影管线收敛

1. 阶段 0：重命名 mapIdReadSubAgentClaim、docIsParamLock、docUpdateRunEnd、ctxReadAiContext
2. mapIdReadSubAgentClaim + docReadClaims + docReadClaimParent 修复
3. docUpdateDraftClaims / docUpdateDraft / docUpdateSaveFlags 收敛
4. docUpdateSplitState 按 pendingTool 分发
5. graph-doc.spec 补 save / confirmRoute / 多槽 parent

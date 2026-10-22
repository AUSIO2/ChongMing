<!-- 应用根组件：承载路由页面并使根容器铺满可用高度。 -->
<template>
  <!-- 路由出口承载当前工作台页面。 -->
  <router-view />
</template>

<style>
/* 让 Vue 根容器继承页面可用高度。 */
#app {
  height: 100%;
}
</style>

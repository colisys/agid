// 浏览器应用入口：Vue 3 + Pinia，esbuild 打包为 ui/app/assets/app.js（IIFE，产物提交入库）。
// 组件用 TSX（src/app/App.tsx + components/*.tsx），esbuild automatic runtime（vue/jsx-runtime）；
// "vue" 默认解析即 runtime-only 版（无模板编译器，产物更小）。
import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App";
import "./style.css";

createApp(App).use(createPinia()).mount("#app");

// Vue JSX 类型补丁：jsx: react-jsx 风格的转换把 children 当 prop 传入，
// 而 Vue 的 NativeElements 各标签直接映射 *HTMLAttributes（无 children 声明）——
// 给本项目用到的四类基础属性接口补上 children，TSX 才能通过 tsc 类型检查
// （运行时 vue/jsx-runtime 的 jsx=h 本来就收 props.children）。
import type {} from "@vue/runtime-dom";

declare module "@vue/runtime-dom" {
  interface HTMLAttributes {
    children?: any;
  }
  interface ButtonHTMLAttributes {
    children?: any;
  }
  interface LabelHTMLAttributes {
    children?: any;
  }
  interface InputHTMLAttributes {
    children?: any;
  }
  interface SVGAttributes {
    children?: any;
  }
}

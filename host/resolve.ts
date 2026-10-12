// 让上游的 .ts 在 node 里直接跑,上游文件一个字不动。两处 wrangler 打包认、node 不认的写法:
//
//   1. 不带扩展名的相对 import(examples/cloudflare/index.ts、src/tools/*.ts 里有):
//      相对路径找不到时补 .ts 再找一次。
//   2. 构造函数参数属性 `constructor(private readonly db: D1Database) {}`
//      (adapters/d1StudyStorage.ts、adapters/vectorizeSemanticSearch.ts):node 默认只剥类型
//      (strip-only),不认这种要改写代码的语法。这两类文件改用 stripTypeScriptTypes 的 transform 模式
//      转一下;其余 .ts 照旧走 node 自带的剥类型。
//
// 只影响本进程,不改任何文件。

import { registerHooks, stripTypeScriptTypes } from 'node:module';

const RELATIVE = /^\.{1,2}\//;
const HAS_EXT = /\.[cm]?[jt]sx?$|\.json$/;
const PARAMETER_PROPERTY = /constructor\s*\([^)]*\b(?:private|public|protected|readonly)\s+\w/;

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error: any) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && RELATIVE.test(specifier) && !HAS_EXT.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (result.format === 'module-typescript' && result.source != null) {
      const source = typeof result.source === 'string' ? result.source : new TextDecoder().decode(result.source as Uint8Array);
      if (PARAMETER_PROPERTY.test(source)) {
        return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url }), shortCircuit: true };
      }
    }
    return result;
  },
});

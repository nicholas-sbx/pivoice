// Turns vosk-browser's bundle into the one piece of it we use: the
// Emscripten glue for its WebAssembly build of Vosk (Kaldi), as an ES
// module, with the WebAssembly still inline.
//
// vosk-browser ships everything as one script that makes its worker from a
// base64 blob, and that worker's glue writes new functions with
// `new Function` (embind's invokers). Our CSP allows neither a blob: worker
// nor eval, and it shouldn't have to, so we take the glue out and run it in
// our own worker (src/captions/worker.ts), and replace those three
// function-writers with plain closures that do the same thing. Then the
// page needs nothing beyond 'wasm-unsafe-eval'.
//
// Pinned to one release by hash: the replacements are written against its
// exact text, and anything else is refused rather than half patched.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { Plugin } from 'vite'

/** vosk-browser 0.0.8's dist/vosk.js. */
export const VOSK_BROWSER_SHA256 = '29504515526e974f4cb053cf08811c4de5fb2a74007c0a5a957db50eaa8d5d0c'

const SITES = [
  {
    name: 'createNamedFunction',
    start: 'function createNamedFunction(name,body){',
    end: '"};\\n")(body)}',
    code: 'function createNamedFunction(name,body){name=makeLegalFunctionName(name);var f=function(){return body.apply(this,arguments)};try{Object.defineProperty(f,"name",{value:name})}catch(e){}return f}'
  },
  {
    name: 'craftInvokerFunction',
    start: 'function craftInvokerFunction(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc){',
    end: 'var invokerFunction=new_(Function,args1).apply(null,args2);return invokerFunction}',
    code: [
      'function craftInvokerFunction(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc){',
      'var argCount=argTypes.length;',
      'if(argCount<2){throwBindingError("argTypes array size mismatch! Must at least get return value and \'this\' types!");}',
      'var isClassMethodFunc=argTypes[1]!==null&&classType!==null;',
      'var needsDestructorStack=false;',
      'for(var i=1;i<argTypes.length;++i){if(argTypes[i]!==null&&argTypes[i].destructorFunction===undefined){needsDestructorStack=true;break}}',
      'var returns=argTypes[0].name!=="void";var expected=argCount-2;',
      'var f=function(){',
      'if(arguments.length!==expected){throwBindingError("function "+humanName+" called with "+arguments.length+" arguments, expected "+expected+" args!");}',
      'var destructors=needsDestructorStack?[]:null;var wired=[cppTargetFunc];var thisWired;',
      'if(isClassMethodFunc){thisWired=argTypes[1].toWireType(destructors,this);wired.push(thisWired);}',
      'var argsWired=new Array(expected);',
      'for(var i=0;i<expected;++i){argsWired[i]=argTypes[i+2].toWireType(destructors,arguments[i]);wired.push(argsWired[i]);}',
      'var rv=cppInvokerFunc.apply(null,wired);',
      'if(needsDestructorStack){runDestructors(destructors);}',
      'else{for(var i=isClassMethodFunc?1:2;i<argTypes.length;++i){var p=i===1?thisWired:argsWired[i-2];if(argTypes[i].destructorFunction!==null){argTypes[i].destructorFunction(p);}}}',
      'if(returns){return argTypes[0].fromWireType(rv);}',
      '};',
      'try{Object.defineProperty(f,"name",{value:makeLegalFunctionName(humanName)})}catch(e){}',
      'return f}'
    ].join('')
  },
  {
    name: '__emval_get_method_caller',
    start: 'function __emval_get_method_caller(argCount,argTypes){',
    end: 'var invokerFunction=new_(Function,params).apply(null,args);return __emval_addMethodCaller(invokerFunction)}',
    code: [
      'function __emval_get_method_caller(argCount,argTypes){',
      'var types=__emval_lookupTypes(argCount,argTypes);var retType=types[0];var n=argCount-1;',
      'var offsets=[];var offset=0;for(var i=0;i<n;++i){offsets.push(offset);offset+=types[i+1]["argPackAdvance"];}',
      'var invokerFunction=function(handle,name,destructors,args){',
      'var a=new Array(n);for(var i=0;i<n;++i){a[i]=types[i+1].readValueFromPointer(args+offsets[i]);}',
      'var rv=handle[name].apply(handle,a);',
      'for(var i=0;i<n;++i){if(types[i+1]["deleteObject"]){types[i+1].deleteObject(a[i]);}}',
      'if(!retType.isVoid){return retType.toWireType(destructors,rv);}',
      '};',
      'return __emval_addMethodCaller(invokerFunction)}'
    ].join('')
  }
]

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

/**
 * vosk-browser's dist/vosk.js in, our module out: `export default LoadVosk`,
 * a function that resolves to the Emscripten module (Model, Recognizer, FS,
 * HEAPF32, _malloc, _free).
 */
export function voskGlue(bundle: string, expectSha = VOSK_BROWSER_SHA256): string {
  if (expectSha && sha256(bundle) !== expectSha) {
    throw new Error(`vosk-browser's dist/vosk.js isn't the release scripts/vosk-glue.mjs was written for (sha256 ${sha256(bundle)}). Check the patches still apply, then update VOSK_BROWSER_SHA256.`)
  }
  const m = /createBase64WorkerFactory\('([A-Za-z0-9+/=]+)'/.exec(bundle)
  if (!m) throw new Error("vosk-browser: couldn't find its worker")
  const worker = Buffer.from(m[1], 'base64').toString('utf8')
  // The glue: `var LoadVosk = (function() { ... })();` inside the worker's module wrapper.
  const a = worker.indexOf('var LoadVosk = (function() {')
  const b = worker.indexOf('module.exports = LoadVosk;', a)
  if (a < 0 || b < 0) throw new Error("vosk-browser: couldn't find the glue in its worker")
  let glue = worker.slice(a, b)
  for (const s of SITES) {
    const i = glue.indexOf(s.start)
    const j = i < 0 ? -1 : glue.indexOf(s.end, i)
    if (i < 0 || j < 0 || glue.indexOf(s.start, i + 1) >= 0) throw new Error(`vosk-browser: ${s.name} isn't where it was`)
    glue = glue.slice(0, i) + s.code + glue.slice(j + s.end.length)
  }
  // Nothing left that writes code at run time.
  if (/new Function|\bnew_\(Function|[^.\w]eval\(/.test(glue)) throw new Error('vosk-browser: the glue still makes functions at run time')
  return glue + '\nexport default LoadVosk;\n'
}

const ID = 'virtual:vosk'

/**
 * `import LoadVosk from 'virtual:vosk'`: the glue above, made from the
 * installed vosk-browser. For the caption worker (src/captions/worker.ts),
 * which is only started once captions are on, so none of its 4 MB is
 * loaded before then.
 */
export function vosk(): Plugin {
  return {
    name: 'pivoice-vosk',
    resolveId(source) {
      return source === ID ? '\0' + ID : null
    },
    load(id) {
      if (id !== '\0' + ID) return null
      const file = createRequire(import.meta.url).resolve('vosk-browser')
      return voskGlue(readFileSync(file, 'utf8'))
    }
  }
}

// SPDX-License-Identifier: GPL-3.0-only
import {createHash} from 'node:crypto';
import {DOCUMENT_ENVELOPE_MAX_BYTES} from './publication-limits.mjs';

export const MEMBER_LIBRARY_SOURCES=Object.freeze(['wiki','raw','graph','facts','brain','stock-price']);
export const MEMBER_LIBRARY_READ_TIMEOUT_MS=90000;
export const memberContextId=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
export const memberCitation=v=>typeof v==='string'&&/^[A-Z]{1,3}[1-9][0-9]{0,2}$/.test(v);
const text=(v,max)=>typeof v==='string'&&v.isWellFormed()&&Buffer.byteLength(v)<=max;
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const date=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const snapshot=v=>exact(v,['name','contentHash','observedAt','engineHash'])&&text(v.name,256)&&hash(v.contentHash)&&date(v.observedAt)&&hash(v.engineHash);
export function memberLibraryReference(v){return exact(v,['ref','sourceType','title','path','excerpt','contentHash'])&&memberCitation(v.ref)&&MEMBER_LIBRARY_SOURCES.includes(v.sourceType)&&text(v.title,4096)&&text(v.path,4096)&&!v.path.startsWith('/')&&!v.path.includes('\\')&&text(v.excerpt,65536)&&hash(v.contentHash);}
export function validMemberLibraryResult(name,v,args){
 if(name==='research_context')return exact(v,['schema','contextId','topic','expiresAt','snapshot','sources','refs','coverage','usage'])&&v.schema==='member-library-context-v1'
  &&memberContextId(v.contextId)&&v.topic===args.topic.trim()&&date(v.expiresAt)&&snapshot(v.snapshot)
  &&Array.isArray(v.sources)&&new Set(v.sources).size===v.sources.length&&v.sources.length===(args.sources??MEMBER_LIBRARY_SOURCES).length&&v.sources.every(s=>(args.sources??MEMBER_LIBRARY_SOURCES).includes(s))
  &&Array.isArray(v.refs)&&v.refs.length<=(args.maxResults??20)&&new Set(v.refs.map(r=>r.ref)).size===v.refs.length&&v.refs.every(r=>memberLibraryReference(r)&&v.sources.includes(r.sourceType))
  &&v.coverage==='ORIGINAL_ENGINE_SELECTED_EXCERPTS'&&exact(v.usage,['modelCalls','webCalls'])&&v.usage.modelCalls===0&&v.usage.webCalls===0&&Buffer.byteLength(JSON.stringify(v))<=128*1024;
 return ['read_wiki','read_evidence'].includes(name)&&exact(v,['schema','contextId','snapshot','reference','contentKind','item'])&&v.schema==='member-library-source-v1'
  &&v.contextId===args.contextId&&snapshot(v.snapshot)&&memberLibraryReference(v.reference)&&v.reference.ref===args.ref
  &&(name==='read_wiki'?v.reference.sourceType==='wiki':v.reference.sourceType!=='wiki')
  &&['full-file','jsonl-record','structured-price-record'].includes(v.contentKind)
  &&exact(v.item,['title','path','contentHash','publishedText','textHash'])&&v.item.title===v.reference.title&&v.item.path===v.reference.path&&v.item.contentHash===v.reference.contentHash
  &&text(v.item.publishedText,4*1024*1024)&&hash(v.item.textHash)&&createHash('sha256').update(v.item.publishedText).digest('hex')===v.item.textHash&&Buffer.byteLength(JSON.stringify(v))<=DOCUMENT_ENVELOPE_MAX_BYTES;
}

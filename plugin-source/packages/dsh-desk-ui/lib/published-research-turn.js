// SPDX-FileCopyrightText: Yangmingjie
// SPDX-License-Identifier: GPL-3.0-only
import {canonicalHash} from "../../../src/schema/canonical-json.mjs";
import {validatePublishedCard} from "../../evidence-provider/src/published-card.mjs";
import {remoteError} from "../../dsh-tools/lib/remote/config.js";

/** Host-only research transaction. It neither creates a personal card nor
 * writes to the source. The callback must buffer output until final proof. */
export function createPublishedResearchTurn({call,readOriginal,currentSourceRevision}) {
  return async (params,operation,{sourceRevision,signal}={})=>{
    if(params?.modelUseAllowed!==true)throw remoteError("MODEL_CONSENT_REQUIRED");
    if(!params||typeof params!=="object"||Array.isArray(params)||
      Object.keys(params).some(key=>!["card","modelUseAllowed"].includes(key))||
      typeof params.card!=="string"||!params.card||params.card.length>200||typeof operation!=="function")
      throw remoteError("INVALID_REQUEST");
    const lifetime=new AbortController();
    const combined=AbortSignal.any([lifetime.signal,AbortSignal.timeout(110_000),...(signal?[signal]:[])]);
    const active=()=>{
      if(combined.aborted)throw remoteError("CANCELLED");
      if(sourceRevision!==currentSourceRevision())throw remoteError("SOURCE_CHANGED");
    };
    const copy=value=>{
      active();
      const inspect=(item,depth=0)=>{
        if(depth>20)throw remoteError("SOURCE_UNAVAILABLE");
        if(item&&typeof item==="object"){
          if(!Array.isArray(item)&&![Object.prototype,null].includes(Object.getPrototypeOf(item)))throw remoteError("SOURCE_UNAVAILABLE");
          for(const child of Object.values(item))inspect(child,depth+1);
        }else if(typeof item==="number"&&!Number.isFinite(item)||
          !["boolean","number","string","undefined"].includes(typeof item)&&item!==null)throw remoteError("SOURCE_UNAVAILABLE");
      };
      inspect(value);const encoded=JSON.stringify(value);
      if(encoded===undefined)return undefined;
      if(Buffer.byteLength(encoded)>256*1024)throw remoteError("SOURCE_UNAVAILABLE");
      return JSON.parse(encoded);
    };
    const read=async datasetId=>{
      active();
      let result;
      if(datasetId===undefined){
        const response=await call("casefile",{card:params.card},{sourceRevision,signal:combined});
        if(!response.ok)throw remoteError(response.error?.code||"SOURCE_UNAVAILABLE");
        result=response.result;
      }else{
        // Admission already fixed the dataset. Each later proof still reads
        // that full original under live server authority; no global rescan or
        // retained authorization decision can relocate the research turn.
        result=await readOriginal({card:params.card,datasetId},{signal:combined});
      }
      active();
      if(!result.publishedCard)throw remoteError("PUBLISHED_CARD_REQUIRED");
      const {publication}=result;
      const card=validatePublishedCard(result.publishedCard,{entityId:params.card,
        revision:publication.revision,contentHash:publication.contentHash,knownAt:publication.knownAt});
      return {card,publication:{cardId:params.card,datasetId:publication.datasetId,
        cardRevisionId:card.cardRevisionId,revision:card.revision,contentHash:publication.contentHash,
        availableAt:publication.availableAt,recordedAt:publication.recordedAt,knownAt:publication.knownAt}};
    };
    try{
      const admitted=await read(),identity=canonicalHash(admitted);
      const {card,publication}=admitted;
      const pin=async()=>{
        try{if(canonicalHash(await read(publication.datasetId))!==identity)throw remoteError("SOURCE_CHANGED");}
        catch(error){
          if(["NO_RESULT","FORBIDDEN_SCOPE","AUTH_REQUIRED","PUBLISHED_CARD_REQUIRED"].includes(error?.code))throw remoteError("SOURCE_CHANGED");
          throw error;
        }
        active();
      };
      const evidence=card.evidence.map(row=>({id:row.id,contentHash:row.contentHash,
        summary:row.quote,sourceLabel:"published-card",materialAt:row.availableAt}));
      const proof={scopeKey:canonicalHash({schema:"published-research-turn-v1",sourceRevision,publication}),
        context:{cardId:params.card,title:card.variableTitle,revision:card.revision,summary:card.eventSummary,
          stageId:"PUBLISHED_CARD",stageLabel:"业主发布原卡",timelineNodeTitle:card.variableTitle,
          projectionStatus:"COMPLETE",watermark:publication.contentHash,materialAt:card.firstDetectedAt,
          scannedAt:card.systemDecisionAt,evidence,evidenceRefs:evidence.map(row=>({id:row.id,contentHash:row.contentHash})),
          evidenceHashes:[...new Set(evidence.map(row=>row.contentHash))]}};
      const readScope={coverage:"REVIEWED_PUBLISHED_CARD",...publication,historyComplete:false};
      const turn=Object.freeze({signal:combined,validateOutput:copy,
        async proveSource(){await pin();return copy(proof);},
        async readEvidence(id){
          active();const row=card.evidence.find(item=>item.id===id);if(!row)throw remoteError("FORBIDDEN_SCOPE");
          await pin();return copy({...row,fullQuote:row.quote,summary:row.quote,accessLevel:"EXCERPT_ONLY",
            datasetId:publication.datasetId,cardRevisionId:card.cardRevisionId});
        },
        async withResearchInput(work){
          if(typeof work!=="function")throw remoteError("INVALID_REQUEST");
          await pin();const result=copy(await work({kind:"published",signal:combined,
            readScope:copy(readScope),publishedCard:copy(card),records:card.evidence.map(row=>({
              evidenceId:row.id,datasetId:publication.datasetId,contentHash:row.contentHash,
              excerpt:row.quote,sourceFamily:"cards/",sourceItemId:row.sourceItemId,sourceRecordHash:row.sourceRecordHash,
              ...(row.retrievalRef?{retrievalRef:row.retrievalRef}:{}),
              availableAt:row.availableAt,recordedAt:row.recordedAt,knownAt:publication.knownAt}))}));
          await pin();return result;
        }});
      const result=copy(await operation(turn));await pin();return result;
    }finally{lifetime.abort();}
  };
}

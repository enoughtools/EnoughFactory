import { AgentManager, type TurnResult, type AgentEvent } from '@enoughfactory/agents';
import type { Chat, ChatEvent, Approval, ApprovalMode, Project, RuntimeKind } from '@enoughfactory/contracts';
import type { DeviceApp } from './app.ts';
import { HttpError, id, now } from './util.ts';
import path from 'node:path';
import { factoryChatBinding } from './factory-chat.ts';

interface PendingApproval { resolve:(decision:boolean)=>void; signal?:AbortSignal; }
interface Question {id:string;chatId:string;questions:unknown;resolve:(answers:Record<string,{answers:string[]}>)=>void;}
export interface RunOptions {attemptId?:string;systemInstructions?:string;autonomous?:boolean;}
export class ChatController {
  readonly manager:AgentManager;
  private approvals=new Map<string,PendingApproval>();
  private questions=new Map<string,Question>();
  private running=new Map<string,Promise<TurnResult>>();
  constructor(readonly app:DeviceApp){
    this.manager=new AgentManager({dockerEndpoint:app.runtime.endpoint,copyHostAuth:true,runtimeAssetsDir:process.env.ENOUGHFACTORY_RESOURCES?path.join(process.env.ENOUGHFACTORY_RESOURCES,'agents'):path.join(app.repositoryRoot,'runtime/agents')});
    for(const chat of app.store.list<Chat>('chats'))if(chat.status==='running'||chat.status==='waiting')app.store.set('chats',{...chat,status:'interrupted',error:'Device service restarted. Resume this conversation to continue.'});
    for(const approval of app.store.list<Approval>('approvals'))if(approval.status==='pending')app.store.set('approvals',{...approval,status:'expired'});
    app.extensions.push(async({method,url,body})=>{
      const route=url.pathname;
      if(method==='POST'&&route==='/api/chats')return this.create({sessionId:String(body.sessionId),runtime:(body.runtime||body.provider) as RuntimeKind,approvalMode:(body.approvalMode||body.policyMode) as ApprovalMode,title:body.title?String(body.title):undefined});
      const match=route.match(/^\/api\/chats\/([^/]+)(?:\/(.+))?$/);
      if(match){const chat=this.get(match[1]),action=match[2];
        if(method==='GET'&&!action)return chat;
        if(method==='GET'&&(action==='messages'||action==='events'))return this.events(chat.id,Number(url.searchParams.get('cursor')||0));
        if(method==='POST'&&action==='messages'){
          app.assertRuntimeCanRun();
          const pending=[...this.questions.values()].find(q=>q.chatId===chat.id);
          if(pending){const text=String(body.text||'');this.event(chat.id,{kind:'message',role:'user',text});const answers=questionAnswers(pending.questions,text);pending.resolve(answers);this.questions.delete(pending.id);this.patch(chat.id,{status:'running'});return {ok:true};}
          void this.run(chat.id,String(body.text||'')).catch(()=>{});return {ok:true};
        }
        if(method==='POST'&&action==='interrupt'){await this.interrupt(chat.id);return {ok:true};}
        if(method==='PATCH'&&!action){if(this.running.has(chat.id))throw new HttpError(409,'Interrupt the current turn before changing runtime policy.');
          const approvalMode=(body.approvalMode||chat.approvalMode) as ApprovalMode;if(!['approve-all','rules','manual'].includes(approvalMode))throw new HttpError(400,'Unknown approval policy.');this.patch(chat.id,{approvalMode,title:typeof body.title==='string'?body.title:chat.title});return this.get(chat.id);}
      }
      const approval=route.match(/^\/api\/approvals\/([^/]+)\/decision$/);
      if(method==='POST'&&approval){this.decide(approval[1],body.decision==='allow');return {ok:true};}
      const runtime=route.match(/^\/api\/sessions\/([^/]+)\/runtimes(?:\/(codex|antigravity|claude)\/(connect|provision))?$/);
      if(runtime){const engine=app.sessions.get(runtime[1]);
        if(method==='GET'){const capabilities=await app.withRuntimeOperation(()=>this.manager.availability(engine.ready.instance));app.diagnostics.runtimes=capabilities;app.changed();return capabilities;}
        if(method==='POST'&&runtime[3]==='provision')return app.withRuntimeOperation(()=>this.manager.provision(engine.ready.instance,runtime[2] as RuntimeKind,{copyHostAuth:body.copyHostAuth!==false}));
        if(method==='POST'&&runtime[3]==='connect'){await app.withRuntimeOperation(()=>this.manager.connectApiKey(engine.ready.instance,runtime[2] as RuntimeKind,String(body.apiKey||'')));return {ok:true};}
      }
      return undefined;
    });
    app.closers.push(()=>this.manager.shutdown());
    app.runtimeStopHooks.push(async()=>{for(const chatId of [...this.running.keys()])await this.interrupt(chatId);});
  }
  get(chatId:string):Chat{const chat=this.app.store.get<Chat>('chats',chatId);if(!chat)throw new HttpError(404,'Conversation not found.');return chat;}
  isRunning(chatId:string):boolean{return this.running.has(chatId);}
  async waitForIdle(chatId:string):Promise<void>{await this.running.get(chatId)?.catch(()=>{});}
  create(input:{sessionId:string;runtime?:RuntimeKind;approvalMode?:ApprovalMode;title?:string;attemptId?:string}):Chat{
    const session=this.app.sessions.record(input.sessionId),project=this.app.store.get<Project>('projects',session.projectId);
    const runtime=input.runtime||project?.runtime||'codex',approvalMode=input.approvalMode||project?.approvalMode||'approve-all';
    if(!['codex','antigravity','claude'].includes(runtime)||!['approve-all','rules','manual'].includes(approvalMode))throw new HttpError(400,'Unknown runtime or policy.');
    const chat:Chat={id:id('chat'),sessionId:session.id,deviceId:this.app.device.id,title:input.title||'New conversation',runtime,approvalMode,status:'idle',createdAt:now(),updatedAt:now(),...(input.attemptId?{attemptId:input.attemptId}:{})};
    this.app.store.set('chats',chat);this.app.changed();return chat;
  }
  event(chatId:string,event:AgentEvent):ChatEvent{
    const record:ChatEvent={...event,id:id('event'),chatId,seq:0,at:now()};
    const seq=this.app.store.append('chat',chatId,record);record.seq=seq;
    if(event.kind==='approval'&&event.data?.approval){const approval=event.data.approval as Approval;this.app.store.set('approvals',approval);if(approval.status!=='pending')this.approvals.delete(approval.id);}
    this.app.emit('chat',record);this.app.changed();return record;
  }
  events(chatId:string,cursor=0):ChatEvent[]{return this.app.store.events<ChatEvent>('chat',chatId,cursor).map(e=>({...e.value,seq:e.seq}));}
  private patch(chatId:string,fields:Partial<Chat>):void{this.app.store.set('chats',{...this.get(chatId),...fields,updatedAt:now()});this.app.changed();}
  run(chatId:string,prompt:string,options:RunOptions={}):Promise<TurnResult>{
    this.app.assertRuntimeCanRun();
    const chat=this.get(chatId);if(!prompt.trim())throw new HttpError(400,'Write a message.');if(this.running.has(chatId))throw new HttpError(409,'This agent is already working.');
    const binding=factoryChatBinding(this.app.store,chat,this.app.device.id);
    if(binding && !options.attemptId)options={...options,attemptId:binding.attemptId,systemInstructions:binding.instructions,autonomous:true};
    const engine=this.app.sessions.get(chat.sessionId),session=this.app.sessions.record(chat.sessionId),project=this.app.store.get<Project>('projects',session.projectId);
    if(options.systemInstructions)this.event(chatId,{kind:'message',role:'system',text:options.systemInstructions});
    this.app.store.delete('chat-results',chatId);this.app.store.delete('chat-turn-failures',chatId);
    this.event(chatId,{kind:'message',role:'user',text:prompt});this.patch(chatId,{status:'running',error:undefined,...(options.attemptId?{attemptId:options.attemptId}:{}),title:chat.title==='New conversation'?prompt.slice(0,64):chat.title});
    const job=this.app.withRuntimeOperation(signal=>{
      const abort=()=>{void this.interrupt(chatId).catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
      return this.manager.runTurn({chatId,sessionId:chat.sessionId,containerId:engine.ready.instance,cwd:engine.ready.workdir,runtime:chat.runtime,approvalMode:chat.approvalMode,rules:project?.rules||[],prompt,threadId:chat.threadId,attemptId:options.attemptId,systemInstructions:options.systemInstructions},{
      onEvent:event=>{this.event(chatId,event);},
      onApproval:async(approval,signal)=>{
        this.app.store.set('approvals',approval);this.patch(chatId,{status:'waiting'});
        return new Promise<boolean>(resolve=>{this.approvals.set(approval.id,{resolve,signal});signal?.addEventListener('abort',()=>{this.approvals.delete(approval.id);resolve(false);},{once:true});});
      },
      onQuestion:async(request,signal)=>{
        if(options.autonomous){
          if(signal.aborted)throw new Error('Factory decision canceled.');
          const decisionId=id('answer');
          const result=await this.app.withRuntimeOperation(runtimeSignal=>{
            const abort=()=>{void this.manager.interrupt(decisionId);};runtimeSignal.addEventListener('abort',abort,{once:true});signal.addEventListener('abort',abort,{once:true});
            return this.manager.runTurn({chatId:decisionId,sessionId:chat.sessionId,containerId:engine.ready.instance,cwd:engine.ready.workdir,runtime:chat.runtime,approvalMode:'approve-all',rules:[],prompt:`Choose the next decision needed to progress this factory goal. Use the existing goal instructions and make reasonable implementation decisions. Do not run tools or ask the user. Return only JSON mapping each question ID to {"answers":["your selected answer"]}.\nGoal context:\n${options.systemInstructions||prompt}\nQuestions:\n${JSON.stringify(request.questions)}`},{onEvent:()=>{},onApproval:async()=>true})
              .finally(()=>{runtimeSignal.removeEventListener('abort',abort);signal.removeEventListener('abort',abort);});
          });
          const match=result.text.match(/\{[\s\S]*\}/);if(!match)throw new Error('The factory decision agent did not return answers.');return JSON.parse(match[0]);
        }
        this.patch(chatId,{status:'waiting'});this.event(chatId,{kind:'status',text:'The agent needs input. Reply in this conversation.',data:{questions:request.questions,requestId:request.id}});
        return new Promise<Record<string,{answers:string[]}>>((resolve,reject)=>{this.questions.set(request.id,{...request,resolve});signal.addEventListener('abort',()=>{this.questions.delete(request.id);reject(new Error('Question canceled.'));},{once:true});});
      }
      }).finally(()=>signal.removeEventListener('abort',abort));
    }).then(result=>{this.app.store.set('chat-results',{id:chatId,result,attemptId:options.attemptId,completedAt:now()});this.patch(chatId,{status:'idle',threadId:result.threadId||chat.threadId});return result;}).catch(error=>{const current=this.get(chatId);this.app.store.set('chat-turn-failures',{id:chatId,attemptId:options.attemptId,error:error.message,code:error.code,agentStarted:error.agentStarted,completedAt:now()});this.patch(chatId,{status:current.status==='interrupted'?'interrupted':'failed',error:error.message});throw error;}).finally(()=>this.running.delete(chatId));
    this.running.set(chatId,job);return job;
  }
  async interrupt(chatId:string):Promise<void>{await this.manager.interrupt(chatId);this.patch(chatId,{status:'interrupted'});}
  decide(approvalId:string,allowed:boolean):void{
    const approval=this.app.store.get<Approval>('approvals',approvalId),pending=this.approvals.get(approvalId);
    if(!approval||approval.status!=='pending'||!pending||pending.signal?.aborted)throw new HttpError(409,'This request is no longer pending.');
    this.app.store.set('approvals',{...approval,status:allowed?'allowed':'denied',decidedAt:now()});this.approvals.delete(approvalId);pending.resolve(allowed);this.patch(approval.chatId,{status:'running'});
  }
}
function questionAnswers(questions:unknown,text:string):Record<string,{answers:string[]}>{
  const list=Array.isArray(questions)?questions:[];const answers:Record<string,{answers:string[]}>={};for(const q of list){const record=q as {id?:string};if(record.id)answers[record.id]={answers:[text]};}return answers;
}

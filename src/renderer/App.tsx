import React,{useEffect,useState} from 'react';
import {Activity,AppWindow,BookCopy,CheckCircle2,Copy,ExternalLink,History,Plus,RefreshCw,Settings,ShieldAlert,X} from 'lucide-react';

type Incident={id:string;title:string;severity:string;start_at:number;sla_minutes:number;status:string;end_at?:number};
type Task={id:string;incident_id:string;due_minutes:number;name:string;description:string;mandatory:number;phase:string;completed_at:number|null;skipped:number};
const fmt=(s:number)=>`${String(Math.floor(s/60)).padStart(2,'0')}:${String(Math.floor(s%60)).padStart(2,'0')}`;
const isFloating=location.hash.startsWith('#/floating/');
const floatingId=decodeURIComponent(location.hash.split('/')[2]||'');
export default function App(){
 const [tab,setTab]=useState('dashboard'),[incidents,setIncidents]=useState<Incident[]>([]),[selected,setSelected]=useState(''),[tasks,setTasks]=useState<Task[]>([]),[tools,setTools]=useState<any[]>([]),[templates,setTemplates]=useState<any[]>([]),[now,setNow]=useState(Date.now()),[newTitle,setNewTitle]=useState('SEV1 Incident'),[newSla,setNewSla]=useState(60),[notice,setNotice]=useState('');
 const active=incidents.find(i=>i.id===(isFloating?floatingId:selected));
 const elapsed=active?Math.max(0,Math.floor((now-active.start_at)/1000)):0;
 const remaining=active?active.sla_minutes*60-elapsed:0;
 const taskState=(t:Task)=>t.completed_at?'done':elapsed>=t.due_minutes*60?'overdue':'upcoming';
 const reload=async()=>{const [i,t,tm,tl]=await Promise.all([window.api.listIncidents(),window.api.listTools(),window.api.listTemplates(),Promise.resolve([])]);setIncidents(i);setTools(t);setTemplates(tm);};
 const loadTasks=async(id:string)=>setTasks(await window.api.listTasks(id));
 useEffect(()=>{reload();const h=setInterval(()=>setNow(Date.now()),500);return()=>clearInterval(h);},[]);
 useEffect(()=>{if(isFloating&&floatingId){setSelected(floatingId);loadTasks(floatingId);}},[]);
 useEffect(()=>{if(selected)loadTasks(selected);},[selected]);
 useEffect(()=>{if(active&&active.status==='active'&&remaining<=0&&remaining>-1)window.api.notify({title:'SEV1 SLA deadline reached',body:active.id});},[Math.floor(remaining)]);
 const create=async()=>{const i=await window.api.createIncident({title:newTitle,severity:'SEV1',slaMinutes:newSla});await reload();setSelected(i.id);setTab('dashboard');};
 const complete=async(t:Task)=>{await window.api.completeTask({taskId:t.id,incidentId:t.incident_id,complete:!t.completed_at});await loadTasks(t.incident_id);};
 const copy=async(t:any)=>{await window.api.copyTemplate([t.subject,t.body].filter(Boolean).join('\n\n'));setNotice(`${t.name} copied to clipboard`);};
 const pct=active?Math.min(1,elapsed/(active.sla_minutes*60)):0;
 const color=pct>=.88?'#ef6666':pct>=.75?'#e9ad54':'#53cdb9';
 const urgent=tasks.filter(t=>!t.completed_at&&elapsed>=t.due_minutes*60);
 const clock=<div className="clock-wrap"><svg viewBox="0 0 240 240" className="clock"><circle cx="120" cy="120" r="91" fill="none" stroke="#dcebe9" strokeWidth="9"/>{Array.from({length:60},(_,i)=>{const a=(i/60)*Math.PI*2-Math.PI/2;const x=120+91*Math.cos(a),y=120+91*Math.sin(a);const lit=active&&elapsed>=i*60;return <circle key={i} cx={x} cy={y} r={i%5===0?4:2.8} fill={lit?(i>=53?'#ef6666':i>=45?'#e9ad54':'#53cdb9'):'#d4e1df'} opacity={lit?1:.75}/>})}<circle cx="120" cy="120" r="72" fill="#f4fbfa" stroke="#d9eeea"/><text x="120" y="112" textAnchor="middle" className="clock-time">{active?fmt(elapsed):'00:00'}</text><text x="120" y="137" textAnchor="middle" className="clock-label">ELAPSED</text></svg><div className="clock-meta"><span style={{color}}>{active?fmt(Math.max(0,remaining)):'--:--'}</span><small>REMAINING SLA</small></div></div>;
 if(isFloating)return <div className="floating"><div className="dragbar"><span>SEV-1 NAVIGATOR</span><button onClick={()=>window.api.closeFloating(floatingId)}><X size={14}/></button></div>{clock}<div className="floating-title">{active?.id||'Loading incident'}</div>{urgent.slice(0,4).map(t=><button className="task-mini" onClick={()=>complete(t)} key={t.id}><span>{t.name}</span><CheckCircle2 size={16}/></button>)}<button className="full-button" onClick={()=>window.api.openMain()}>Open dashboard</button></div>;
 return <div className="app">
  <aside className="sidebar"><div className="brand"><div className="brand-icon"><ShieldAlert/></div><div><b>SEV-1 NAVIGATOR</b><small>INCIDENT RESPONSE</small></div></div>
   {[['dashboard','Dashboard',Activity],['activities','Activities',CheckCircle2],['tools','Tool launcher',AppWindow],['templates','Communication templates',BookCopy],['history','Incident history',History],['settings','Settings',Settings]].map(([id,label,Icon]:any)=><button className={`nav ${tab===id?'selected':''}`} onClick={()=>setTab(id)} key={id}><Icon size={17}/>{label}</button>)}
   <div className="sidebar-foot">LOCAL MODE · DATA STAYS ON THIS DEVICE</div>
  </aside>
  <main className="main">
   <header><div><div className="eyebrow">INCIDENT OPERATIONS</div><h1>{({dashboard:'Incident Dashboard',activities:'Activity Manager',tools:'Tool Launcher',templates:'Communication Templates',history:'Incident History',settings:'Settings'} as any)[tab]}</h1></div><div className="header-right"><span className="local-pill">● LOCAL</span><button className="icon-button" onClick={reload}><RefreshCw size={17}/></button></div></header>
   {notice&&<div className="notice">{notice}<button onClick={()=>setNotice('')}>Dismiss</button></div>}
   {tab==='dashboard'&&<><section className="hero-row"><div><div className="eyebrow">ACTIVE INCIDENTS</div><h2>Stay ahead of every milestone.</h2><p>Independent timers, visible deadlines and response actions.</p></div><button className="primary" onClick={()=>create()}><Plus size={17}/> New SEV1 incident</button></section>
    <div className="incident-grid">{incidents.filter(i=>i.status==='active').map(i=>{const e=Math.floor((now-i.start_at)/1000),r=i.sla_minutes*60-e;return <button className={`incident-card ${selected===i.id?'chosen':''}`} key={i.id} onClick={()=>setSelected(i.id)}><div className="card-top"><span className="sev">SEV1</span><span className="live-dot">● ACTIVE</span></div><b>{i.title}</b><small>{i.id}</small><div className="card-bottom"><div><strong>{fmt(e)}</strong><small>ELAPSED</small></div><div><strong className={r<=900?'danger':''}>{fmt(Math.max(0,r))}</strong><small>REMAINING</small></div></div><div className="progress"><i style={{width:`${Math.min(100,e/(i.sla_minutes*60)*100)}%`}}/></div></button>})}</div>
    <div className="content-grid"><section className="panel clock-panel"><div className="panel-head"><div><h3>Incident SLA clock</h3><p>{active?.id||'Select an active incident'}</p></div>{active&&<button className="secondary" onClick={()=>window.api.openFloating(active.id)}>Pop out clock</button>}</div>{clock}{active&&<div className="clock-caption">{remaining<=0?'SLA DEADLINE REACHED':remaining<=900?'CRITICAL WINDOW':remaining<=900?'SLA WARNING':'RESPONSE IN PROGRESS'}</div>}</section>
    <section className="panel"><div className="panel-head"><div><h3>Response checklist</h3><p>Tasks are calculated from incident start time</p></div><span className="count">{tasks.filter(t=>t.completed_at).length}/{tasks.length}</span></div>{tasks.length?tasks.map(t=><button key={t.id} className={`task-row ${taskState(t)}`} onClick={()=>complete(t)}><span className="task-check">{t.completed_at?<CheckCircle2 size={18}/>:<span/>}</span><span className="task-copy"><b>{t.name}</b><small>Due at {t.due_minutes} min · {t.phase||'General'}</small></span><span className="task-status">{t.completed_at?'DONE':taskState(t)==='overdue'?'OVERDUE':'UPCOMING'}</span></button>):<div className="empty">Create or select an incident to view its checklist.</div>}</section></div>
   </>}
   {tab==='activities'&&<section className="panel"><div className="panel-head"><div><h3>Incident response milestones</h3><p>Checklist activities are configured in the project workbook.</p></div></div><p className="muted">The Activities sheet provides the task template for new incidents. Existing incident checklists remain unchanged.</p></section>}
   {tab==='tools'&&<div className="tool-grid">{tools.map(t=><button className="tool-card" key={t.id} onClick={()=>window.api.openTool(t.url)}><div className="tool-icon"><AppWindow/></div><b>{t.name}</b><small>{t.description}</small><ExternalLink size={15}/></button>)}</div>}
   {tab==='templates'&&<div className="template-grid">{templates.map(t=><section className="panel template-card" key={t.id}><div className="template-stage">{t.stage}</div><h3>{t.name}</h3>{t.subject&&<div className="subject">{t.subject}</div>}<pre>{t.body}</pre><button className="primary copy-button" onClick={()=>copy(t)}><Copy size={15}/> Copy template</button></section>)}</div>}
   {tab==='history'&&<section className="panel"><h3>Incident history</h3>{incidents.filter(i=>i.status!=='active').map(i=><div className="history-row" key={i.id}><b>{i.title}</b><span>{i.id}</span><span>{new Date(i.start_at).toLocaleString()}</span><span>{i.status}</span></div>)}{!incidents.some(i=>i.status!=='active')&&<div className="empty">Resolved incidents will appear here.</div>}</section>}
   {tab==='settings'&&<section className="panel"><h3>Local application settings</h3><p className="muted">This first build stores data in the operating system's application data directory. No incident data is transmitted to a server.</p><div className="setting-row"><span>Default SLA</span><b>60 minutes (configurable per incident)</b></div><div className="setting-row"><span>Storage</span><b>Local SQLite database</b></div><div className="setting-row"><span>Core internet dependency</span><b>None</b></div></section>}
  </main>
 </div>
}

export {};
declare global {
  interface Window { api: {
    listIncidents:()=>Promise<any[]>; createIncident:(data:any)=>Promise<any>;
    listTasks:(id:string)=>Promise<any[]>; completeTask:(data:any)=>Promise<boolean>;
    resolveIncident:(id:string)=>Promise<boolean>; listTools:()=>Promise<any[]>;
    openTool:(url:string)=>Promise<boolean>; listTemplates:()=>Promise<any[]>;
    copyTemplate:(text:string)=>Promise<boolean>; openFloating:(id:string)=>Promise<boolean>;
    toggleFloatingPin:()=>Promise<boolean>;
    openMain:(incidentId?:string)=>Promise<boolean>; closeFloating:(id:string)=>Promise<void>;
    notify:(data:any)=>Promise<void>;
    onTasksUpdated:(callback:(incidentId:string)=>void)=>()=>void;
    onIncidentsUpdated:(callback:(incidentId:string)=>void)=>()=>void;
    onFocusIncident:(callback:(incidentId:string)=>void)=>()=>void;
    onConfigUpdated:(callback:(result:any)=>void)=>()=>void;
    onConfigError:(callback:(message:string)=>void)=>()=>void;
  }}
}

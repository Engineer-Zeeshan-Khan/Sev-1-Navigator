export {};
declare global {
  interface Window { api: {
    listIncidents:()=>Promise<any[]>; createIncident:(data:any)=>Promise<any>;
    listTasks:(id:string)=>Promise<any[]>; completeTask:(data:any)=>Promise<boolean>;
    resolveIncident:(id:string)=>Promise<boolean>; listTools:()=>Promise<any[]>;
    saveTool:(data:any)=>Promise<boolean>; openTool:(url:string)=>Promise<boolean>;
    listTemplates:()=>Promise<any[]>; saveTemplate:(data:any)=>Promise<boolean>;
    copyTemplate:(text:string)=>Promise<boolean>; openFloating:(id:string)=>Promise<boolean>;
    toggleFloatingPin:()=>Promise<boolean>;
    openMain:(incidentId?:string)=>Promise<boolean>; closeFloating:(id:string)=>Promise<void>;
    notify:(data:any)=>Promise<void>; importExcel:(path:string)=>Promise<any>; getConfigPath:()=>Promise<string>; openConfigFolder:()=>Promise<string>; reloadConfig:()=>Promise<any>;
    exportExcelTemplate:()=>Promise<any>; chooseAndImportExcel:()=>Promise<any>;
    onTasksUpdated:(callback:(incidentId:string)=>void)=>()=>void;
    onIncidentsUpdated:(callback:(incidentId:string)=>void)=>()=>void;
    onFocusIncident:(callback:(incidentId:string)=>void)=>()=>void;
    onConfigUpdated:(callback:(result:any)=>void)=>()=>void;
    onConfigError:(callback:(message:string)=>void)=>()=>void;
  }}
}

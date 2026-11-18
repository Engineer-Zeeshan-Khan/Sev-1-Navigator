import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('api', {
  listIncidents:()=>ipcRenderer.invoke('incidents:list'),
  createIncident:(data:any)=>ipcRenderer.invoke('incidents:create',data),
  listTasks:(id:string)=>ipcRenderer.invoke('incidents:tasks',id),
  completeTask:(data:any)=>ipcRenderer.invoke('tasks:complete',data),
  resolveIncident:(id:string)=>ipcRenderer.invoke('incidents:resolve',id),
  listTools:()=>ipcRenderer.invoke('tools:list'),
  saveTool:(data:any)=>ipcRenderer.invoke('tools:save',data),
  openTool:(url:string)=>ipcRenderer.invoke('tools:open',url),
  listTemplates:()=>ipcRenderer.invoke('templates:list'),
  saveTemplate:(data:any)=>ipcRenderer.invoke('templates:save',data),
  copyTemplate:(text:string)=>ipcRenderer.invoke('templates:copy',text),
  openFloating:(id:string)=>ipcRenderer.invoke('window:open-floating',id),
  openMain:()=>ipcRenderer.invoke('window:open-main'),
  closeFloating:(id:string)=>ipcRenderer.invoke('window:close-floating',id),
  notify:(data:any)=>ipcRenderer.invoke('notifications:show',data),
  importExcel:(path:string)=>ipcRenderer.invoke('excel:import',path),
  chooseAndImportExcel:()=>ipcRenderer.invoke('excel:choose-import'),
  getConfigPath:()=>ipcRenderer.invoke('excel:config-path'),
  openConfigFolder:()=>ipcRenderer.invoke('excel:open-config-folder'),
  reloadConfig:()=>ipcRenderer.invoke('excel:reload-config'),
  exportExcelTemplate:()=>ipcRenderer.invoke('excel:export-template')
});

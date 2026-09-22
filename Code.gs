/************************************************************
 *  MFC RAN Site Tracker — Backend (Sheets + Drive)
 ************************************************************/
const DRIVE_FOLDER_NAME = "MFC_SMR_Files";

function doGet(e){
  try{
    const action = (e && e.parameter && e.parameter.action) || "read";
    if(action === "read") return jsonResponse(readSheet());
    return jsonResponse({ ok:false, error:"Unknown action" });
  }catch(err){ return jsonResponse({ ok:false, error: err.toString() }); }
}

function doPost(e){
  try{
    if(!e || !e.postData || !e.postData.contents)
      return jsonResponse({ ok:false, error:"No payload" });
    const payload = JSON.parse(e.postData.contents);
    if(payload.action === "uploadPdf") return jsonResponse(uploadPdfToDrive(payload));
    if(payload.headers && payload.rows) return jsonResponse(writeSheet(payload));
    return jsonResponse({ ok:false, error:"Unknown payload" });
  }catch(err){ return jsonResponse({ ok:false, error: err.toString() }); }
}

function readSheet(){
  const sheet  = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  const values = sheet.getDataRange().getValues();
  if(values.length === 0) return { headers:[], rows:[] };
  const headers = values[0].map(h => String(h));
  const rows = values.slice(1).map(r => {
    const obj = {};
    headers.forEach((h,i) => {
      obj[h] = (r[i] !== undefined && r[i] !== null) ? r[i].toString() : "";
    });
    return obj;
  });
  return { headers, rows };
}

function writeSheet(payload){
  const sheet   = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  const headers = payload.headers;
  const rows    = payload.rows || [];
  sheet.clearContents();
  sheet.getRange(1,1,1,headers.length).setValues([headers]);
  if(rows.length){
    const values = rows.map(r => headers.map(h => {
      const v = r[h];
      return (v === undefined || v === null) ? "" : v;
    }));
    sheet.getRange(2,1,values.length,headers.length).setValues(values);
  }
  sheet.setFrozenRows(1);
  return { status:"ok", count: rows.length };
}

function uploadPdfToDrive(payload){
  const { fileName, base64, mimeType, siteId } = payload;
  if(!base64)   return { ok:false, error:"Missing base64" };
  if(!fileName) return { ok:false, error:"Missing fileName" };
  let folder;
  const folders = DriveApp.getFoldersByName(DRIVE_FOLDER_NAME);
  folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(DRIVE_FOLDER_NAME);
  const oldFiles = folder.getFilesByName(fileName);
  while(oldFiles.hasNext()){ try{ oldFiles.next().setTrashed(true); }catch(e){} }
  const bytes = Utilities.base64Decode(base64);
  const blob  = Utilities.newBlob(bytes, mimeType || "application/pdf", fileName);
  const file  = folder.createFile(blob);
  try{ file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); }catch(e){}
  const fileId = file.getId();
  if(siteId){ try{ file.setDescription("MFC Site: " + siteId); }catch(e){} }
  return {
    ok: true, fileId: fileId, fileName: fileName,
    viewUrl:     "https://drive.google.com/file/d/" + fileId + "/view",
    previewUrl:  "https://drive.google.com/file/d/" + fileId + "/preview",
    downloadUrl: "https://drive.google.com/uc?export=download&id=" + fileId
  };
}

function jsonResponse(obj){
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

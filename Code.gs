function analyzeConsumption(smrItems, consumption){
  const map = new Map();

  (smrItems||[]).forEach(it=>{
    const key = normalizeCode(it.code);
    if(!key) return;
    map.set(key, {
      code: it.code,
      desc: it.desc || "",
      unit: it.unit || "-",
      ordered: it.qty || 0,
      price: it.price || 0,
      consumed: 0,
      note: ""
    });
  });

  (consumption||[]).forEach(c=>{
    const key = normalizeCode(c.code);
    if(!key) return;
    if(map.has(key)){
      const item = map.get(key);
      item.consumed += (parseInt(c.qty,10) || 0);
      if(c.note) item.note = c.note;
    } else {
      map.set(key, {
        code: c.code,
        desc: c.desc || "",
        unit: c.unit || "-",
        ordered: 0,
        price: 0,
        consumed: parseInt(c.qty,10) || 0,
        note: c.note || ""
      });
    }
  });

  const items = [];
  map.forEach(v=>{
    const diff = v.consumed - v.ordered;
    let status = "pending"; // 🔑 جديد — لم يُستهلك بعد

    if(v.consumed > 0){
      if(diff < 0)      status = "shortage";
      else if(diff > 0) status = "excess";
      else              status = "match";
    } else if(v.ordered === 0 && v.consumed === 0){
      status = "empty";
    }

    items.push({...v, diff, status});
  });

  return {
    items,
    shortages: items.filter(i=>i.status === "shortage"),
    excesses:  items.filter(i=>i.status === "excess"),
    matches:   items.filter(i=>i.status === "match"),
    pendings:  items.filter(i=>i.status === "pending")
  };
}

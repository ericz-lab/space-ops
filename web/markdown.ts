/** A small Markdown subset for reports the agent writes: headings, lists, quotes, code, emphasis. Escapes first, so model text can never become markup. */
const esc=(s:string)=>s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
const inline=(s:string)=>esc(s).replace(/`([^`]+)`/g,"<code>$1</code>").replace(/\*\*([^*]+)\*\*/g,"<strong>$1</strong>").replace(/(^|[^*])\*([^*\s][^*]*)\*/g,"$1<em>$2</em>");
export function markdown(text:string):string{
  const out:string[]=[],lines=text.replace(/\r/g,"").split("\n");let list:"ul"|"ol"|null=null,para:string[]=[];
  const flush=()=>{if(para.length){out.push(`<p>${para.map(inline).join("<br>")}</p>`);para=[];}if(list){out.push(`</${list}>`);list=null;}};
  for(let i=0;i<lines.length;i++){
    const line=lines[i]!;
    if(/^\s*```/.test(line)){flush();const code:string[]=[];while(++i<lines.length&&!/^\s*```/.test(lines[i]!))code.push(lines[i]!);out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);continue;}
    const h=line.match(/^(#{1,4})\s+(.*)$/);if(h){flush();const n=Math.min(4,h[1]!.length+1);out.push(`<h${n}>${inline(h[2]!)}</h${n}>`);continue;}
    const li=line.match(/^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/);
    if(li){if(para.length){out.push(`<p>${para.map(inline).join("<br>")}</p>`);para=[];}const kind=li[1]?"ul":"ol";if(list!==kind){if(list)out.push(`</${list}>`);out.push(`<${kind}>`);list=kind;}out.push(`<li>${inline(li[3]!)}</li>`);continue;}
    if(list&&/^\s{2,}\S/.test(line)){out[out.length-1]=out[out.length-1]!.replace(/<\/li>$/,`<br>${inline(line.trim())}</li>`);continue;}
    const q=line.match(/^>\s?(.*)$/);if(q){flush();out.push(`<blockquote>${inline(q[1]!)}</blockquote>`);continue;}
    if(/^\s*(-{3,}|\*{3,})\s*$/.test(line)){flush();out.push("<hr>");continue;}
    if(!line.trim()){flush();continue;}
    if(list){out.push(`</${list}>`);list=null;}
    para.push(line.trim());
  }
  flush();return out.join("");
}

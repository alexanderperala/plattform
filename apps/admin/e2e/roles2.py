"""Rollbaserad E2E: Billing, Technical, Read-only samt avslag av four-eyes. Misslyckas (exit 1) vid avvikelse."""
import hmac,hashlib,base64,struct,time,json,random,subprocess,sys,urllib.request
from playwright.sync_api import sync_playwright
S="JBSWY3DPEHPK3PXP"; FAIL=[]
def totp(off=0):
    k=base64.b32decode(S); c=int(time.time())//30+off
    h=hmac.new(k,struct.pack(">Q",c),hashlib.sha1).digest(); o=h[-1]&15
    return "%06d"%((struct.unpack(">I",h[o:o+4])[0]&0x7fffffff)%1000000)
def check(cond,msg):
    print(("OK   " if cond else "FEL  ")+msg)
    if not cond: FAIL.append(msg)
def sql(q): return subprocess.run(["psql","postgres://plattform:plattform_dev@localhost:5432/plattform_dev","-tAc",q],capture_output=True,text=True).stdout.strip()
def login(b,email):
    pg=b.new_page(viewport={"width":1300,"height":900}); pg.goto("http://127.0.0.1:5173/")
    pg.fill('input[type=email]',email); pg.fill('input[type=password]',"DevAdminPassword!2026"); pg.click("text=Fortsätt")
    pg.wait_for_selector("text=Tvåstegsverifiering"); pg.fill("input",totp()); pg.click("button:has-text('Verifiera')"); pg.wait_for_selector("h1:has-text('Översikt')"); return pg
def nav(pg): return [a.inner_text().split("\n")[0].strip() for a in pg.query_selector_all("nav a")]
def status(pg,method,path,body=None):
    return pg.evaluate("""([m,p,b])=>fetch('/api/platform-admin'+p,{method:m,credentials:'same-origin',headers:{'content-type':'application/json','x-requested-with':'platform-admin'},body:b?JSON.stringify(b):undefined}).then(r=>r.status)""",[method,path,body])
def reauth(pg,btn):
    try: pg.wait_for_selector("div.modal input[autocomplete=one-time-code]",timeout=2500)
    except Exception: return
    pg.fill("div.modal input[autocomplete=one-time-code]",totp(1)); pg.click(f"div.modal button:has-text('{btn}')")
def register():
    tag=str(random.randint(10000,99999)); name=f"Roll-E2E {tag}"
    req=urllib.request.Request("http://127.0.0.1:4000/api/v1/auth/register",method="POST",headers={"content-type":"application/json","x-requested-with":"platform-customer"},
        data=json.dumps({"email":f"roll{tag}@example.test","password":"Kundlösenord-2026","name":"Roll Kund","workspaceName":name,"products":["association_portal"],"acceptTerms":True}).encode())
    urllib.request.urlopen(req).read(); return name
with sync_playwright() as p:
    b=p.chromium.launch()
    # ---- Billing Admin
    pg=login(b,"billing@example.test"); n=nav(pg)
    check("Kunder" in n and "Produkter och licenser" in n, f"billing ser Kunder och Produkter: {n}")
    check(not any(x in n for x in ("Användare","Granskningslogg","Tekniska fel","Administratörer","Inställningar")), "billing ser inte användare, audit, fel, admins, inställningar")
    check(status(pg,"GET","/users")==403 and status(pg,"GET","/audit")==403 and status(pg,"GET","/logs/errors")==403, "billing nekas användare/audit/fel direkt mot API (403)")
    check(status(pg,"GET","/settings")==403 and status(pg,"GET","/admins")==403, "billing nekas inställningar och admins (403)")
    check(status(pg,"GET","/workspaces")==200, "billing får läsa kunder (200)")
    pg.close()
    # ---- Technical Admin
    pg=login(b,"tech@example.test"); n=nav(pg)
    check("Tekniska fel" in n and "Granskningslogg" in n and "Funktionsflaggor" in n, f"tekniker ser fel, audit, flaggor: {n}")
    check("Inställningar" not in n and "Administratörer" not in n, "tekniker ser inte inställningar/admins")
    check(status(pg,"GET","/logs/errors")==200 and status(pg,"GET","/audit")==200, "tekniker får läsa fel och audit (200)")
    check(status(pg,"GET","/settings")==403 and status(pg,"POST","/support/cases",{"subject":"x y z","category":"other"})==403, "tekniker nekas inställningar och supportärenden (403)")
    pg.click("nav a[href='/logs']"); pg.wait_for_selector("h1"); pg.close()
    # ---- Read-only Admin
    pg=login(b,"readonly@example.test"); n=nav(pg)
    check("Kunder" in n and "Granskningslogg" in n and "Administratörer" not in n and "Inställningar" not in n, f"read-only nav: {n}")
    pg.click("nav a[href='/customers']"); pg.wait_for_selector("tbody tr"); pg.click("tbody tr >> nth=0"); pg.wait_for_selector("text=Kunduppgifter")
    check(len(pg.query_selector_all(".page-head button"))==0, "read-only ser inga åtgärdsknappar på kunddetaljen")
    wid=pg.url.split("/")[-1]
    check(status(pg,"POST","/support/cases",{"subject":"Försök","category":"other"})==403, "read-only nekas att skapa ärende (403)")
    check(status(pg,"PATCH",f"/workspaces/{wid}",{"reason":"Försök utan behörighet","name":"Hackat"})==403, "read-only nekas att ändra kund (403)")
    check(status(pg,"POST",f"/workspaces/{wid}/suspend",{"reason":"Försök utan behörighet"})==403, "read-only nekas att pausa kund (403)")
    check(status(pg,"GET","/audit")==200, "read-only får läsa audit (200)")
    pg.close()
    # ---- Avslag av four-eyes
    name=register()
    sa=login(b,"super@example.test")
    sa.click("nav a[href='/customers']"); sa.fill("input[type=search]",name); sa.wait_for_selector(f"tbody tr:has-text('{name}')"); sa.click(f"tbody tr:has-text('{name}')"); sa.wait_for_selector("text=Kunduppgifter")
    sa.click("button:has-text('Avsluta…')"); sa.fill("textarea","Begäran som ska avslås i E2E-testet av fyra-ögon"); sa.click("button:has-text('Begär avslut')"); reauth(sa,'Begär avslut')
    sa.wait_for_selector("text=kräver godkännande",timeout=6000)
    check(sql(f"select status from workspaces where name='{name}'")=="Active", "kunden är fortfarande Active efter begäran")
    ow=login(b,"owner@example.test"); ow.click("nav a[href='/approvals']"); ow.wait_for_selector(f"tr:has-text('{name}')")
    ow.click(f"tr:has-text('{name}') button:has-text('Avslå')"); ow.click("div.modal button:has-text('Avslå')"); reauth(ow,'Avslå')
    ow.wait_for_selector(f"tr:has-text('{name}'):has-text('Avslagen')",timeout=6000)
    check(True,"begäran visas som Avslagen i UI")
    check(sql(f"select status from workspaces where name='{name}'")=="Active", "kunden är fortfarande Active efter avslag (inget utfördes)")
    check(sql(f"select status from approval_requests where target_id=(select id from workspaces where name='{name}') order by requested_at desc limit 1")=="rejected", "approval_requests.status = rejected")
    check(int(sql("select count(*) from admin_audit_log where action like 'approval.reject%' and at > now() - interval '5 minutes'") or 0)>=1, "avslaget finns i audit")
    # avslagen begäran kan inte godkännas i efterhand
    aid=sql(f"select id from approval_requests where target_id=(select id from workspaces where name='{name}') order by requested_at desc limit 1")
    check(len(aid)==36, "begäran hittades i databasen")
    ow.evaluate("fetch('/api/platform-admin/auth/reauth',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json','x-requested-with':'platform-admin'},body:JSON.stringify({code:'%s'})})"%totp(1)); ow.wait_for_timeout(500)
    st=status(ow,"POST",f"/approvals/{aid}/approve",{})
    check(st in (409,400,403) and sql(f"select status from workspaces where name='{name}'")=="Active", f"avslagen begäran kan inte godkännas efteråt (HTTP {st})")
    b.close()
print("\nRESULTAT:", "ALLA KONTROLLER OK" if not FAIL else f"{len(FAIL)} FEL")
sys.exit(1 if FAIL else 0)

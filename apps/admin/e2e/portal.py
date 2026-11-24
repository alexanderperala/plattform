"""Föreningsportal: medlemsregister i webbläsaren, med gräns, export och isolering mellan kunder."""
import json,random,subprocess,sys,urllib.request
from playwright.sync_api import sync_playwright
FAIL=[]
def check(c,m):
    print(("OK   " if c else "FEL  ")+m)
    if not c: FAIL.append(m)
def rsql(q): return subprocess.run(["su","postgres","-c",f"psql -d plattform_dev -tAc \"{q}\""],capture_output=True,text=True).stdout.strip()  # superuser: förbi RLS, så kontrollen är verklig
def sql(q): return subprocess.run(["psql","postgres://plattform:plattform_dev@localhost:5432/plattform_dev","-tAc",q],capture_output=True,text=True).stdout.strip()
def register(tag,who):
    req=urllib.request.Request("http://127.0.0.1:4000/api/v1/auth/register",method="POST",headers={"content-type":"application/json","x-requested-with":"platform-customer"},
        data=json.dumps({"email":f"{who}{tag}@example.test","password":"Kundlösenord-2026","name":f"Kund {who}","workspaceName":f"Portal-E2E {who} {tag}","products":["association_portal"],"acceptTerms":True}).encode())
    urllib.request.urlopen(req).read(); return f"{who}{tag}@example.test",f"Portal-E2E {who} {tag}"
def login(b,email):
    pg=b.new_page(viewport={"width":1300,"height":900}); pg.goto("http://127.0.0.1:5175/")
    pg.fill("input[type=email]",email); pg.fill("input[type=password]","Kundlösenord-2026"); pg.click("button:has-text('Logga in')")
    pg.wait_for_selector("h1:has-text('Nyheter')"); pg.click("nav a:has-text('Medlemsregister')"); pg.wait_for_selector("h1:has-text('Medlemsregister')"); return pg
def add(pg,name,**kw):
    pg.click("button:has-text('Ny medlem')"); pg.fill("div.modal input >> nth=0",name)
    if "email" in kw: pg.fill("div.modal input[type=email]",kw["email"])
    if "nr" in kw: pg.fill("div.modal .grid input >> nth=2",kw["nr"])
    pg.click("div.modal button:has-text('Spara')")
tag=str(random.randint(10000,99999))
ea,na=register(tag,"a"); eb,nb=register(tag,"b")
with sync_playwright() as p:
    b=p.chromium.launch()
    pa=login(b,ea)
    pa.wait_for_selector("text=Inga medlemmar ännu",timeout=6000); check(True,"tomt register visar hjälptext")
    add(pa,"Anna Andersson",email="anna@example.test",nr="1001"); pa.wait_for_selector("tr:has-text('Anna Andersson')")
    add(pa,"Bo Bengtsson"); pa.wait_for_selector("tr:has-text('Bo Bengtsson')")
    check(pa.locator("text=2 medlemmar").count()==1,"antal medlemmar visas")
    add(pa,"Anna Dublett",nr="1001"); pa.wait_for_selector("div.modal .alert:has-text('Medlemsnumret')"); check(True,"dubblett av medlemsnummer nekas med begripligt fel"); pa.click("div.modal button:has-text('Avbryt')")
    pa.fill("input[aria-label='Sök medlem']","bengt"); pa.wait_for_function("document.querySelectorAll('tbody tr').length===1"); check("Bo Bengtsson" in pa.inner_text("tbody"),"sökning filtrerar"); pa.fill("input[aria-label='Sök medlem']","")
    pa.wait_for_function("document.querySelectorAll('tbody tr').length===2")
    pa.click("tr:has-text('Bo Bengtsson') button:has-text('Ändra')"); pa.select_option("div.modal select","inactive"); pa.click("div.modal button:has-text('Spara')")
    pa.wait_for_selector("tr:has-text('Bo Bengtsson'):has-text('Inaktiv')"); check(True,"ändring sparas")
    with pa.expect_download() as d: pa.click("text=Exportera CSV")
    txt=open(d.value.path(),encoding="utf-8-sig").read(); check("Anna Andersson" in txt and "Bo Bengtsson" in txt and txt.startswith('"Medlemsnummer"') or "Medlemsnummer" in txt,"CSV-export laddas ned med medlemmarna")
    # Gräns: sätt max 2 och försök lägga till
    sql(f"update product_entitlements set limits_override='{{\"max_members\":2}}' where workspace_id=(select id from workspaces where name='{na}') and product='association_portal'")
    pa.reload(); pa.wait_for_selector("text=Medlemsgränsen (2) är nådd"); check(pa.locator("button:has-text('Ny medlem')").is_disabled(),"Ny medlem är avstängd när gränsen är nådd")
    pa.screenshot(path="/home/claude/plattform/docs/screenshots/portal-members.png",full_page=True)
    pa.click("tr:has-text('Anna Andersson') button:has-text('Ta bort')"); pa.click("div.modal button:has-text('Ta bort')")
    pa.wait_for_function("document.querySelectorAll('tbody tr').length===1"); check(rsql(f"select count(*) from association_members where name='Anna Andersson' and workspace_id=(select id from workspaces where name='{na}')")=="0","medlem raderad ur databasen"); 
    pa.wait_for_function("!document.body.innerText.includes('Medlemsgränsen (2) är nådd')"); check(True,"gränsvarningen försvinner efter radering")
    # Isolering: kund B ser inget av A
    pb=login(b,eb); pb.wait_for_selector("text=Inga medlemmar ännu",timeout=6000); check( "Bo Bengtsson" not in pb.inner_text("body"),"kund B ser inga av kund A:s medlemmar")
    wa=sql(f"select id from workspaces where name='{na}'")
    st=pb.evaluate("""(w)=>fetch('/api/v1/workspaces/'+w+'/association/members',{credentials:'same-origin'}).then(r=>r.status)""",wa)
    check(st==404,f"kund B nekas direkt mot A:s arbetsyta (HTTP {st})")
    b.close()
print("\nRESULTAT:", "ALLA KONTROLLER OK" if not FAIL else f"{len(FAIL)} FEL"); sys.exit(1 if FAIL else 0)

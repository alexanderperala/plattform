"""Turneringssystem: skapa serie, lag, start, resultat, tabell, medlemsvy och tenant-isolering (browser)."""
import json,random,subprocess,sys,urllib.request
from playwright.sync_api import sync_playwright
FAIL=[]
def check(c,m):
    print(("OK   " if c else "FEL  ")+m)
    if not c: FAIL.append(m)
def rsql(q): return subprocess.run(["su","postgres","-c",f"psql -d plattform_dev -tAc \"{q}\""],capture_output=True,text=True).stdout.strip()  # superuser: förbi RLS
def sql(q): return subprocess.run(["psql","postgres://plattform:plattform_dev@localhost:5432/plattform_dev","-tAc",q],capture_output=True,text=True).stdout.strip()
def register(tag,who):
    req=urllib.request.Request("http://127.0.0.1:4000/api/v1/auth/register",method="POST",headers={"content-type":"application/json","x-requested-with":"platform-customer"},
        data=json.dumps({"email":f"{who}{tag}@example.test","password":"Kundlösenord-2026","name":f"Kund {who}","workspaceName":f"Tur-E2E {who} {tag}","products":["tournament_system"],"acceptTerms":True}).encode())
    urllib.request.urlopen(req).read(); return f"{who}{tag}@example.test",f"Tur-E2E {who} {tag}"
def login(b,email,ws=None):
    pg=b.new_page(viewport={"width":1300,"height":900}); pg.goto("http://127.0.0.1:5176/")
    pg.fill("input[type=email]",email); pg.fill("input[type=password]","Kundlösenord-2026"); pg.click("button:has-text('Logga in')"); pg.wait_for_selector("h1:has-text('Turneringar')")
    if ws: pg.select_option("select[aria-label='Arbetsyta']",label=ws); pg.wait_for_selector("h1:has-text('Turneringar')")
    return pg
tag=str(random.randint(10000,99999)); ea,na=register(tag,"adm"); es,ns=register(tag,"stf"); ex,nx=register(tag,"oth")
wid=sql(f"select id from workspaces where name='{na}'")
sql(f"insert into workspace_members (workspace_id,user_id,role) values ('{wid}',(select id from users where email='{es}'),'member')")
with sync_playwright() as p:
    b=p.chromium.launch(); pa=login(b,ea)
    pa.wait_for_selector("text=Inga turneringar ännu"); check(True,"tom lista visar hjälptext")
    pa.click("button:has-text('Ny turnering')"); pa.fill("div.modal input >> nth=0","Vårserien"); pa.click("div.modal button:has-text('Skapa')")
    pa.wait_for_selector("h1:has-text('Vårserien')"); check(pa.locator(".badge:has-text('Utkast')").count()==1,"ny turnering är utkast")
    check(pa.locator("button:has-text('Starta turneringen')").is_disabled(),"start kräver minst två lag")
    for n in ("Röda","Blå","Gröna"):
        pa.fill("input[aria-label=Lagnamn]",n); pa.click("button:has-text('Lägg till lag')"); pa.wait_for_selector(f"ul[aria-label=Lag] li:has-text('{n}')")
    pa.fill("input[aria-label=Lagnamn]","röda"); pa.click("button:has-text('Lägg till lag')"); pa.wait_for_selector("text=finns redan"); check(pa.locator("ul[aria-label=Lag] li").count()==3,"dubblettlag nekas")
    pa.click("button:has-text('Starta turneringen')"); pa.wait_for_selector("h2:has-text('Tabell')")
    check(pa.locator("[data-testid=match]").count()==3,"tre matcher genereras för tre lag")
    check(rsql(f"select count(*) from tournament_matches where workspace_id='{wid}'")=="3","matcherna ligger i databasen")
    ms=pa.locator("[data-testid=match]")
    for i in range(3):
        row=ms.nth(i); row.locator("input >> nth=0").fill("2"); row.locator("input >> nth=1").fill(str(i)); row.locator("button:has-text('Spara')").click(); pa.wait_for_timeout(400)
    pa.click("button:has-text('Avsluta turneringen')"); pa.wait_for_selector("text=Turneringen är avslutad")
    check(rsql(f"select status from tournaments where workspace_id='{wid}'")=="finished","status avslutad i databasen")
    check(pa.locator("tbody tr").count()==3 and pa.locator("tbody tr >> nth=0").inner_text().strip().startswith("1"),"tabell med tre rader och placering 1")
    pa.screenshot(path="/home/claude/plattform/docs/screenshots/tournament-standings.png")
    # medlemsvy: kan läsa men inte skriva
    ps=login(b,es,na); ps.click("a:has-text('Vårserien')"); ps.wait_for_selector("h2:has-text('Tabell')")
    check(ps.locator("button:has-text('Spara')").count()==0 and ps.locator("button:has-text('Radera')").count()==0 and ps.locator("button:has-text('Ny turnering')").count()==0,"vanlig medlem ser tabellen men inga redigeringsknappar")
    # annan arbetsyta ser inget
    po=login(b,ex); po.wait_for_selector("text=Inga turneringar ännu"); check(True,"annan arbetsyta ser inte turneringen")
    # skapa i draft och radera
    pa.click("a:has-text('← Turneringar')"); pa.click("button:has-text('Ny turnering')"); pa.fill("div.modal input >> nth=0","Slängs"); pa.click("div.modal button:has-text('Skapa')"); pa.wait_for_selector("h1:has-text('Slängs')")
    pa.once("dialog",lambda d:d.accept()); pa.click("button:has-text('Radera')"); pa.wait_for_selector("h1:has-text('Turneringar')")
    check(rsql(f"select count(*) from tournaments where workspace_id='{wid}' and name='Slängs'")=="0","utkast raderat")
    b.close()
print("\nRESULTAT:","ALLA KONTROLLER OK" if not FAIL else f"{len(FAIL)} FEL"); sys.exit(1 if FAIL else 0)

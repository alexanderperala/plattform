"""Föreningsportal: kalender. Skapa/publicera, anmälan ur medlemsregistret, kapacitet och synlighet per roll."""
import json,random,subprocess,sys,urllib.request
from datetime import datetime,timedelta
from playwright.sync_api import sync_playwright
FAIL=[]
def check(c,m):
    print(("OK   " if c else "FEL  ")+m)
    if not c: FAIL.append(m)
def sql(q): return subprocess.run(["psql","postgres://plattform:plattform_dev@localhost:5432/plattform_dev","-tAc",q],capture_output=True,text=True).stdout.strip()
def wsql(wid,q):
    r=subprocess.run(["psql","postgres://plattform:plattform_dev@localhost:5432/plattform_dev","-qtA","-v","ON_ERROR_STOP=1"],input=f"begin;\nselect set_config('app.workspace_id','{wid}',true) \\g /dev/null\n{q};\ncommit;",capture_output=True,text=True)
    if r.returncode: print(r.stderr); sys.exit(2)
    return r.stdout.strip().splitlines()[-1] if r.stdout.strip() else ""
def register(tag,who):
    req=urllib.request.Request("http://127.0.0.1:4000/api/v1/auth/register",method="POST",headers={"content-type":"application/json","x-requested-with":"platform-customer"},
        data=json.dumps({"email":f"{who}{tag}@example.test","password":"Kundlösenord-2026","name":f"Kund {who}","workspaceName":f"Cal-E2E {who} {tag}","products":["association_portal"],"acceptTerms":True}).encode())
    urllib.request.urlopen(req).read(); return f"{who}{tag}@example.test",f"Cal-E2E {who} {tag}"
def login(b,email,ws=None,page="Kalender"):
    pg=b.new_page(viewport={"width":1300,"height":900}); pg.goto("http://127.0.0.1:5175/")
    pg.fill("input[type=email]",email); pg.fill("input[type=password]","Kundlösenord-2026"); pg.click("button:has-text('Logga in')"); pg.wait_for_selector("h1:has-text('Nyheter')")
    if ws: pg.select_option("select[aria-label='Arbetsyta']",label=ws); pg.wait_for_selector("h1:has-text('Nyheter')")
    pg.click(f"nav a:has-text('{page}')"); pg.wait_for_selector(f"h1:has-text('{page}')"); return pg
def when(days,h=18): return (datetime.now()+timedelta(days=days)).replace(hour=h,minute=0,second=0,microsecond=0).strftime("%Y-%m-%dT%H:%M")
tag=str(random.randint(10000,99999)); ea,na=register(tag,"adm"); es,ns=register(tag,"stf")
wid=sql(f"select id from workspaces where name='{na}'")
sql(f"insert into workspace_members (workspace_id,user_id,role) values ('{wid}',(select id from users where email='{es}'),'member')")
for n in ("Anna Andersson","Bo Bengtsson","Cia Dahl"): wsql(wid,f"insert into association_members (workspace_id,name) values ('{wid}','{n}')")
with sync_playwright() as p:
    b=p.chromium.launch(); pa=login(b,ea)
    pa.wait_for_selector("text=Inga kommande aktiviteter"); check(True,"tom kalender visar hjälptext")
    pa.click("button:has-text('Ny aktivitet')"); pa.fill("div.modal input >> nth=0","Torsdagsträning")
    pa.fill("div.modal input[type=datetime-local] >> nth=0",when(3)); pa.fill("div.modal input[type=datetime-local] >> nth=1",when(3,20))
    pa.fill("div.modal .grid input >> nth=2","Idrottshallen"); pa.fill("div.modal input[type=number]","2"); pa.fill("div.modal textarea","Ta med vatten.\nRad två."); pa.click("div.modal button:has-text('Spara')")
    pa.wait_for_selector("article:has-text('Torsdagsträning')"); check(pa.locator("article .badge:has-text('Utkast')").count()==1,"ny aktivitet sparas som utkast")
    check("Idrottshallen" in pa.inner_text("article") and "0 anmälda av 2" in pa.inner_text("article"),"plats och kapacitet visas")
    # sluttid före start nekas
    pa.click("article button:has-text('Redigera')"); pa.fill("div.modal input[type=datetime-local] >> nth=1",when(2)); pa.click("div.modal button:has-text('Spara')")
    pa.wait_for_timeout(700); check(pa.locator("div.modal").count()==1 and wsql(wid,f"select count(*) from association_events where workspace_id='{wid}' and ends_at < starts_at")=="0","sluttid före start stoppas i formuläret (servern nekar likadant, testat i API-testerna)"); pa.click("div.modal button:has-text('Avbryt')")
    # anmälan
    pa.click("article button:has-text('Visa och hantera anmälda')"); pa.wait_for_selector("div.modal:has-text('Inga anmälda ännu')")
    pa.fill("div.modal input[type=search]","Anna"); pa.click("div.modal li:has-text('Anna Andersson') button:has-text('Anmäl')"); pa.wait_for_selector("ul[aria-label='Anmälda'] li:has-text('Anna Andersson')")
    pa.fill("div.modal input[type=search]","Bo"); pa.click("div.modal li:has-text('Bo Bengtsson') button:has-text('Anmäl')"); pa.wait_for_selector("ul[aria-label='Anmälda'] li:has-text('Bo Bengtsson')")
    check("Fullsatt" in pa.inner_text("div.modal"),"aktiviteten markeras fullsatt när kapaciteten nås")
    check(pa.locator("div.modal input[type=search]").is_disabled(),"anmälan stängs när det är fullt")
    pa.screenshot(path="/home/claude/plattform/docs/screenshots/portal-events-attendees.png")
    pa.click("div.modal li:has-text('Bo Bengtsson') button:has-text('Avanmäl')"); pa.wait_for_selector("ul[aria-label='Anmälda']:not(:has-text('Bo Bengtsson'))"); check(not pa.locator("div.modal input[type=search]").is_disabled(),"avanmälan öppnar platsen igen")
    pa.click("div.modal button:has-text('Stäng')")
    # synlighet
    ps=login(b,es,na); ps.wait_for_selector("text=Inga kommande aktiviteter"); check(ps.locator("text=Inga kommande aktiviteter").count()==1 and ps.locator("button:has-text('Ny aktivitet')").count()==0,"vanlig medlem ser inget utkast och ingen skapa-knapp")
    pa.click("article button:has-text('Publicera')"); pa.wait_for_selector("article:not(:has(.badge:has-text('Utkast')))")
    ps.reload(); ps.wait_for_selector("article:has-text('Torsdagsträning')")
    check("1 anmälda av 2" in ps.inner_text("article"),"medlem ser antal anmälda")
    ps.click("article button:has-text('Visa')"); ps.wait_for_selector("div.modal:has-text('Deltagarlistan visas bara för administratörer')")
    check("Anna Andersson" not in ps.inner_text("div.modal"),"medlem ser inte deltagarnas namn (personuppgifter)")
    ps.screenshot(path="/home/claude/plattform/docs/screenshots/portal-events-member.png")
    # radera medlem ur registret -> anmälan försvinner
    wsql(wid,f"delete from association_members where name='Anna Andersson' and workspace_id='{wid}'")
    check(wsql(wid,f"select count(*) from association_event_attendees where workspace_id='{wid}'")=="0","raderad medlem tas bort från anmälningar (kaskad)")
    # tidigare
    pa.select_option("select[aria-label='Visa']","past"); pa.wait_for_selector("text=Inga tidigare aktiviteter"); check(True,"tidigare-vyn är separat och tom")
    pa.select_option("select[aria-label='Visa']","upcoming"); pa.wait_for_selector("article:has-text('Torsdagsträning')")
    pa.click("article button:has-text('Ta bort')"); pa.click("div.modal button:has-text('Ta bort')"); pa.wait_for_selector("text=Inga kommande aktiviteter")
    check(wsql(wid,f"select count(*) from association_events where workspace_id='{wid}'")=="0","aktivitet raderad")
    b.close()
print("\nRESULTAT:", "ALLA KONTROLLER OK" if not FAIL else f"{len(FAIL)} FEL"); sys.exit(1 if FAIL else 0)

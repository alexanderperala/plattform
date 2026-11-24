"""Föreningsportal: nyheter. Utkast/publicering, synlighet per roll och text (inte HTML) för innehållet."""
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
        data=json.dumps({"email":f"{who}{tag}@example.test","password":"Kundlösenord-2026","name":f"Kund {who}","workspaceName":f"News-E2E {who} {tag}","products":["association_portal"],"acceptTerms":True}).encode())
    urllib.request.urlopen(req).read(); return f"{who}{tag}@example.test",f"News-E2E {who} {tag}"
def login(b,email,ws=None):
    pg=b.new_page(viewport={"width":1300,"height":900}); pg.goto("http://127.0.0.1:5175/")
    pg.fill("input[type=email]",email); pg.fill("input[type=password]","Kundlösenord-2026"); pg.click("button:has-text('Logga in')"); pg.wait_for_selector("h1:has-text('Nyheter')")
    if ws: pg.select_option("select[aria-label='Arbetsyta']",label=ws); pg.wait_for_selector("h1:has-text('Nyheter')")
    return pg
tag=str(random.randint(10000,99999)); ea,na=register(tag,"adm"); es,ns=register(tag,"stf")
sql(f"insert into workspace_members (workspace_id,user_id,role) values ((select id from workspaces where name='{na}'),(select id from users where email='{es}'),'member')")
with sync_playwright() as p:
    b=p.chromium.launch(); pa=login(b,ea)
    pa.wait_for_selector("text=Inga nyheter ännu"); check(True,"tom nyhetslista visar hjälptext för admin")
    evil='<img src=x onerror="window.__xss=1">Hej'
    pa.click("button:has-text('Ny nyhet')"); pa.fill("div.modal input >> nth=0","Årsmöte 15 mars"); pa.fill("div.modal textarea",f"Kallelse följer.\nRad två\n{evil}"); pa.click("div.modal button:has-text('Spara')")
    pa.wait_for_selector("article:has-text('Årsmöte 15 mars')"); check(pa.locator("article:has-text('Årsmöte 15 mars') .badge:has-text('Utkast')").count()==1,"ny nyhet sparas som utkast")
    check(pa.evaluate("window.__xss")is None and pa.locator("article img").count()==0,"HTML i texten renderas som text (ingen XSS)")
    check("<img src=x" in pa.inner_text("article"),"texten visas ordagrant")
    # personal (vanlig medlem) via arbetsyteväljaren
    ps=login(b,es,na); check(ps.locator("text=Inga nyheter har publicerats ännu").count()==1 and ps.locator("button:has-text('Ny nyhet')").count()==0,"vanlig medlem ser inget utkast och ingen knapp för ny nyhet")
    pa.click("article:has-text('Årsmöte 15 mars') button:has-text('Publicera')"); pa.wait_for_selector("article:has-text('Årsmöte 15 mars'):has-text('Publicerad')"); check(True,"admin publicerar")
    ps.reload(); ps.wait_for_selector("h1:has-text('Nyheter')")
    if ps.locator("select[aria-label='Arbetsyta']").count(): ps.select_option("select[aria-label='Arbetsyta']",label=na)
    ps.wait_for_selector("article:has-text('Årsmöte 15 mars')"); check(ps.locator("article button").count()==0,"medlem ser publicerad nyhet utan hanteringsknappar")
    ps.screenshot(path="/home/claude/plattform/docs/screenshots/portal-news-member.png",full_page=True)
    pa.click("article:has-text('Årsmöte 15 mars') button:has-text('Redigera')"); pa.check("div.modal input[type=checkbox]"); pa.fill("div.modal input >> nth=0","Årsmöte 15 mars (fäst)"); pa.click("div.modal button:has-text('Spara')")
    pa.wait_for_selector("article:has-text('(fäst)')"); check("Kallelse följer." in pa.inner_text("article"),"redigering av rubrik behåller texten")
    pa.click("article button:has-text('Avpublicera')"); pa.wait_for_selector("article .badge:has-text('Utkast')")
    ps.reload(); ps.wait_for_selector("h1:has-text('Nyheter')")
    if ps.locator("select[aria-label='Arbetsyta']").count(): ps.select_option("select[aria-label='Arbetsyta']",label=na)
    ps.wait_for_selector("text=Inga nyheter har publicerats ännu"); check(True,"avpublicerad nyhet försvinner för medlemmen")
    pa.click("article button:has-text('Ta bort')"); pa.click("div.modal button:has-text('Ta bort')"); pa.wait_for_selector("text=Inga nyheter ännu")
    check(rsql(f"select count(*) from association_news where workspace_id=(select id from workspaces where name='{na}')")=="0","nyhet raderad ur databasen")
    b.close()
print("\nRESULTAT:", "ALLA KONTROLLER OK" if not FAIL else f"{len(FAIL)} FEL"); sys.exit(1 if FAIL else 0)

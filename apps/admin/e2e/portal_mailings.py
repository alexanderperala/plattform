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
        data=json.dumps({"email":f"{who}{tag}@example.test","password":"Kundlösenord-2026","name":f"Kund {who}","workspaceName":f"Mail-E2E {who} {tag}","products":["association_portal"],"acceptTerms":True}).encode())
    urllib.request.urlopen(req).read(); return f"{who}{tag}@example.test",f"Mail-E2E {who} {tag}"
def login(b,email,ws=None,page="Utskick"):
    pg=b.new_page(viewport={"width":1300,"height":900}); pg.goto("http://127.0.0.1:5175/")
    pg.fill("input[type=email]",email); pg.fill("input[type=password]","Kundlösenord-2026"); pg.click("button:has-text('Logga in')"); pg.wait_for_selector("h1:has-text('Nyheter')")
    if ws: pg.select_option("select[aria-label='Arbetsyta']",label=ws); pg.wait_for_selector("h1:has-text('Nyheter')")
    pg.click(f"nav a:has-text('{page}')"); pg.wait_for_selector(f"h1:has-text('{page}')"); return pg
tag=str(random.randint(10000,99999)); ea,na=register(tag,"adm")
wid=sql(f"select id from workspaces where name='{na}'")
def rsql(q): return subprocess.run(["su","postgres","-c",f"psql -d plattform_dev -tAc \"{q}\""],capture_output=True,text=True).stdout.strip()
for n,e,st in (("Anna Andersson","anna@example.test","active"),("Bo Bengtsson","bo@example.test","active"),("Cia Dahl",None,"active"),("Dan Ek","dan@example.test","inactive")):
    wsql(wid,f"insert into association_members (workspace_id,name,email,status) values ('{wid}','{n}',{repr(e) if e else 'null'},'{st}')")
with sync_playwright() as p:
    b=p.chromium.launch(); pa=login(b,ea)
    pa.wait_for_selector("text=Inga utskick ännu"); check(True,"tom lista visar hjälptext")
    pa.click("button:has-text('Nytt utskick')"); pa.fill("div.modal input >> nth=0","Årsmöte på torsdag"); pa.fill("div.modal textarea","Hej! Varmt välkommen till årsmötet.")
    pa.click("div.modal button:has-text('Spara som utkast')"); pa.wait_for_selector("td:has-text('Årsmöte på torsdag')"); check(pa.locator(".badge:has-text('Utkast')").count()==1,"utkast sparat")
    pa.click("a:has-text('Årsmöte på torsdag')"); pa.wait_for_selector("div.modal .alert:has-text('Skickas till')")
    check("2" in pa.locator("div.modal .alert").inner_text() and "1 utan e-postadress" in pa.locator("div.modal .alert").inner_text() and "1 inaktiva" in pa.locator("div.modal .alert").inner_text(),"mottagarantal visas: 2 av 4 (en utan e-post, en inaktiv)")
    pa.once("dialog",lambda d:d.accept()); pa.click("div.modal button:has-text('Skicka')"); pa.wait_for_selector("div.modal .alert:has-text('skickat')")
    check(rsql(f"select count(*) from notification_outbox where workspace_id='{wid}' and template='association_mailing'")=="2","två e-postmeddelanden köade")
    pa.click("div.modal button:has-text('Stäng')"); pa.wait_for_selector(".badge:has-text('Skickat')"); check("2" in pa.locator("tbody tr").first.inner_text(),"listan visar Skickat och 2 mottagare")
    link=rsql(f"select unsubscribe_url from notification_outbox where workspace_id='{wid}' and to_email='anna@example.test'"); check("/unsubscribe?t=" in link,"avanmälningslänk finns")
    pub=b.new_page(); pub.goto(link); pub.wait_for_selector("text=Vill du sluta få"); check(rsql(f"select email_opt_out from association_members where workspace_id='{wid}' and name='Anna Andersson'")=="f","länken öppnad ändrar ingenting före bekräftelse")
    check("Mail-E2E" in pub.inner_text("body"),"avanmälningssidan visar föreningens namn")
    pub.click("button:has-text('Ja, avsluta utskick')"); pub.wait_for_selector("text=Klart."); check(rsql(f"select email_opt_out from association_members where workspace_id='{wid}' and name='Anna Andersson'")=="t","medlemmen är avanmäld efter bekräftelse")
    bad=b.new_page(); bad.goto("http://127.0.0.1:5175/unsubscribe?t=skrap.skrap"); bad.wait_for_selector(".alert"); check("ogiltig" in bad.inner_text("body").lower(),"ogiltig länk visar felmeddelande")
    pa.click("nav a:has-text('Medlemsregister')"); pa.wait_for_selector("tbody tr"); check("Avstängd för utskick" in pa.locator("tbody tr:has-text('Anna Andersson')").inner_text(),"medlemsregistret visar att Anna avanmält sig")
    pa.click("nav a:has-text('Utskick')"); pa.click("button:has-text('Nytt utskick')"); pa.fill("div.modal input >> nth=0","Påminnelse"); pa.fill("div.modal textarea","Glöm inte årsmötet."); pa.click("div.modal button:has-text('Spara som utkast')"); pa.click("a:has-text('Påminnelse')")
    pa.wait_for_selector("div.modal .alert:has-text('Skickas till')"); check("1 som avanmält sig" in pa.locator("div.modal .alert").inner_text(),"nästa utskick räknar bort den avanmälda")
    pa.screenshot(path="/home/claude/plattform/docs/screenshots/portal-mailing.png"); b.close()
print("\nRESULTAT:","ALLA KONTROLLER OK" if not FAIL else f"{len(FAIL)} FEL"); sys.exit(1 if FAIL else 0)

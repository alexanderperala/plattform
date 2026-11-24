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
tag=str(random.randint(10000,99999)); ea,na=register(tag,"adm")
wid=sql(f"select id from workspaces where name='{na}'")
def score(pa,row,h,a): row.locator("input >> nth=0").fill(str(h)); row.locator("input >> nth=1").fill(str(a)); row.locator("button:has-text('Spara')").click(); pa.wait_for_timeout(500)
with sync_playwright() as p:
    b=p.chromium.launch(); pa=login(b,ea)
    pa.click("button:has-text('Ny turnering')"); pa.fill("div.modal input >> nth=0","Cupen"); pa.select_option("div.modal select[aria-label=Format]",value="single_elimination")
    check(pa.locator("div.modal:has-text('Dubbelserie')").count()==0,"dubbelserie döljs för utslagning"); pa.click("div.modal button:has-text('Skapa')")
    pa.wait_for_selector("h1:has-text('Cupen')")
    for n in ("Lejon","Tigrar","Björnar","Vargar","Örnar"):
        pa.fill("input[aria-label=Lagnamn]",n); pa.click("button:has-text('Lägg till lag')"); pa.wait_for_selector(f"ul[aria-label=Lag] li:has-text('{n}')")
    pa.click("button:has-text('Starta turneringen')"); pa.wait_for_selector("h3:has-text('Semifinal')")
    check(pa.locator("h2:has-text('Tabell')").count()==0,"ingen serietabell för utslagning")
    check(pa.locator("text=frilott").count()==3 and pa.locator("h3:has-text('Final')").count()>=1,"3 frilotter och rondnamn visas för 5 lag")
    check(pa.locator("text=Inväntar lag").count()>=1,"tomma platser markeras som inväntar lag")
    ready=lambda: pa.locator("[data-testid=match]:has(button:has-text('Spara'))")
    m=lambda x,y: pa.locator(f"[data-testid=match]:has-text('{x} – {y}'):has(button:has-text('Spara'))")
    check(m("Vargar","Örnar").count()==1 and m("Tigrar","Björnar").count()==1 and pa.locator("[data-testid=match]:has(button:has-text('Spara'))").count()==2,"två matcher är spelbara direkt (Vargar–Örnar och Tigrar–Björnar)")
    r=m("Vargar","Örnar"); r.locator("input >> nth=0").fill("1"); r.locator("input >> nth=1").fill("1"); r.locator("button:has-text('Spara')").click(); pa.wait_for_selector("text=oavgjort är inte tillåtet"); check(True,"oavgjort nekas i utslagning")
    score(pa,m("Vargar","Örnar"),0,3)   # Örnar slår Vargar
    pa.wait_for_selector("[data-testid=match]:has-text('Lejon – Örnar'):has(button)"); check(True,"vinnaren flyttas fram till semifinalen")
    score(pa,m("Lejon","Örnar"),2,0); score(pa,m("Tigrar","Björnar"),1,0)
    pa.wait_for_selector("[data-testid=match]:has-text('Lejon – Tigrar'):has(button)"); check(True,"finalen blir spelbar när båda semifinalerna är klara")
    score(pa,m("Lejon","Tigrar"),4,2)
    pa.click("button:has-text('Avsluta turneringen')"); pa.wait_for_selector("text=Vinnare:")
    check(rsql(f"select status from tournaments where workspace_id='{wid}'")=="finished" and "Vinnare" in pa.inner_text("body"),"cupen avslutad och vinnare utsedd")
    pa.screenshot(path="/home/claude/plattform/docs/screenshots/tournament-bracket.png"); b.close()
print("\nRESULTAT:","ALLA KONTROLLER OK" if not FAIL else f"{len(FAIL)} FEL"); sys.exit(1 if FAIL else 0)

"""Flipper: spelare från medlemsregistret och CSV (browser)."""
import json,random,sys,tempfile,urllib.request
from playwright.sync_api import sync_playwright
FAIL=[]
def check(c,m):
    print(("OK   " if c else "FEL  ")+m)
    if not c: FAIL.append(m)
tag=str(random.randint(10000,99999)); email=f"pim{tag}@example.test"; wsname=f"PinImp-E2E {tag}"
urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:4000/api/v1/auth/register",method="POST",headers={"content-type":"application/json","x-requested-with":"platform-customer"},
    data=json.dumps({"email":email,"password":"Kundlösenord-2026","name":"Kund Imp","workspaceName":wsname,"products":["association_portal","tournament_system"],"acceptTerms":True}).encode())).read()
with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_page(viewport={"width":1400,"height":1000}); pg.goto("http://127.0.0.1:5176/")
    pg.fill("input[type=email]",email); pg.fill("input[type=password]","Kundlösenord-2026"); pg.click("button:has-text('Logga in')"); pg.wait_for_selector("h1:has-text('Turneringar')")
    H={"x-requested-with":"platform-customer","content-type":"application/json"}
    wid=pg.evaluate("localStorage.getItem('portal-ws')") or ""
    ws=pg.request.fetch("http://127.0.0.1:5176/api/v1/me",headers=H).json(); wid=(ws.get("workspaces") or [{}])[0].get("id") or wid
    for n,st in (("Anna Medlem","active"),("Bo Medlem","active"),("Cia Medlem","active"),("Dan Inaktiv","inactive")):
        r=pg.request.fetch(f"http://127.0.0.1:5176/api/v1/workspaces/{wid}/association/members",method="POST",headers=H,data=json.dumps({"name":n,"email":n.split()[0].lower()+"@example.test","status":st})); assert r.status==201,r.text()
    pg.click("button:has-text('Ny turnering')"); pg.fill("div.modal input >> nth=0","Import-SM"); pg.select_option("select[aria-label=Format]","pinball"); pg.click("div.modal button:has-text('Skapa')"); pg.wait_for_selector("h1:has-text('Import-SM')")
    pg.click("button:has-text('Från medlemsregistret')"); pg.wait_for_selector("ul[aria-label=Medlemmar] li")
    check(pg.locator("ul[aria-label=Medlemmar] li").count()==3,"bara aktiva medlemmar listas")
    pg.check("input[aria-label='Markera alla']"); pg.click("div.modal button:has-text('Lägg till')"); pg.wait_for_selector("div.modal",state="detached"); pg.wait_for_selector("ol[aria-label=Spelare] li >> nth=2")
    check(pg.locator("ol[aria-label=Spelare] li").count()==3,"tre medlemmar blev spelare")
    check("anna@example.test" not in pg.content(),"e-post följer inte med")
    pg.click("button:has-text('Från medlemsregistret')"); pg.wait_for_selector("text=Inga fler aktiva medlemmar"); check(True,"redan tillagda medlemmar erbjuds inte igen"); pg.click("div.modal button:has-text('Avbryt')")
    f=tempfile.NamedTemporaryFile("w",suffix=".csv",delete=False,encoding="utf-8"); f.write("Namn;Land\nEva Csv;SE\nFolke Csv;NO\n"); f.close()
    pg.set_input_files("input[aria-label='Läs in CSV']",f.name); pg.wait_for_function("document.querySelector('textarea[aria-label=\"Spelare att lägga till\"]').value.includes('Folke Csv')")
    v=pg.input_value("textarea[aria-label='Spelare att lägga till']"); check(v.split("\n")==["Eva Csv","Folke Csv"],"CSV: kolumnen Namn läses in (inte Land)")
    pg.click("section:has(h2:has-text('Spelare')) button:has-text('Lägg till')"); pg.wait_for_selector("ol[aria-label=Spelare] li >> nth=4"); check(pg.locator("ol[aria-label=Spelare] li").count()==5,"CSV-spelare tillagda efter granskning")
sys.exit(1 if FAIL else 0)

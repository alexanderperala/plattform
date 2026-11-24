"""Föreningsportal: CSV-import med förhandsgranskning, felrader och gräns."""
import json,random,subprocess,sys,urllib.request,tempfile,os
from playwright.sync_api import sync_playwright
FAIL=[]
def check(c,m):
    print(("OK   " if c else "FEL  ")+m)
    if not c: FAIL.append(m)
def rsql(q): return subprocess.run(["su","postgres","-c",f"psql -d plattform_dev -tAc \"{q}\""],capture_output=True,text=True).stdout.strip()  # superuser: förbi RLS, så kontrollen är verklig
def sql(q): return subprocess.run(["psql","postgres://plattform:plattform_dev@localhost:5432/plattform_dev","-tAc",q],capture_output=True,text=True).stdout.strip()
tag=str(random.randint(10000,99999)); email=f"imp{tag}@example.test"; ws=f"Import-E2E {tag}"
req=urllib.request.Request("http://127.0.0.1:4000/api/v1/auth/register",method="POST",headers={"content-type":"application/json","x-requested-with":"platform-customer"},
    data=json.dumps({"email":email,"password":"Kundlösenord-2026","name":"Imp Kund","workspaceName":ws,"products":["association_portal"],"acceptTerms":True}).encode())
urllib.request.urlopen(req).read()
def tmp(name,content):
    p=os.path.join(tempfile.mkdtemp(),name); open(p,"w",encoding="utf-8").write(content); return p
good=tmp("bra.csv","Medlemsnummer;Namn;E-post;Status\n1;Åsa Ålander;asa@example.test;Aktiv\n2;Örjan Öberg;;Inaktiv\n3;Ida Ek;;\n")
mixed=tmp("blandad.csv","Namn;Medlemsnummer;E-post\nBra Person;10;bra@example.test\n;11;\nDålig Epost;12;inte-epost\nDublett;10;\n")
more=tmp("mer.csv","Medlemsnummer;Namn\n21;Ny Ett\n22;Ny Två\n23;Ny Tre\n")
with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_page(viewport={"width":1300,"height":900}); pg.goto("http://127.0.0.1:5175/")
    pg.fill("input[type=email]",email); pg.fill("input[type=password]","Kundlösenord-2026"); pg.click("button:has-text('Logga in')"); pg.wait_for_selector("h1:has-text('Nyheter')"); pg.click("nav a:has-text('Medlemsregister')"); pg.wait_for_selector("text=Inga medlemmar ännu")
    pg.click("button:has-text('Importera CSV')"); pg.set_input_files("div.modal input[type=file]",mixed)
    pg.wait_for_selector("div.modal:has-text('4 rader')"); txt=pg.inner_text("div.modal")
    check("1 giltiga, 3 med fel" in txt,"förhandsgranskning visar 1 giltig och 3 felaktiga rader")
    check(pg.locator("div.modal button:has-text('Importera 1 medlemmar')").is_disabled(),"import är avstängd tills man väljer att hoppa över felrader")
    check("förekommer flera gånger" in txt and "Namn" in txt or "flera gånger" in txt,"fel per rad förklaras (dubblett i filen)")
    check(rsql(f"select count(*) from association_members where workspace_id=(select id from workspaces where name='{ws}')")=="0","förhandsgranskning skriver ingenting")
    pg.screenshot(path="/home/claude/plattform/docs/screenshots/portal-import-preview.png")
    pg.check("div.modal input[type=checkbox]"); pg.click("div.modal button:has-text('Importera 1 medlemmar')")
    pg.wait_for_selector("div.modal:has-text('1 medlemmar importerades')"); check("3 rader hoppades över" in pg.inner_text("div.modal"),"resultat visar importerade och överhoppade"); pg.click("div.modal button:has-text('Klart')")
    pg.wait_for_selector("tr:has-text('Bra Person')")
    pg.click("button:has-text('Importera CSV')"); pg.set_input_files("div.modal input[type=file]",good); pg.wait_for_selector("div.modal:has-text('3 rader')")
    pg.click("div.modal button:has-text('Importera 3 medlemmar')"); pg.wait_for_selector("div.modal:has-text('3 medlemmar importerades')"); pg.click("div.modal button:has-text('Klart')")
    pg.wait_for_selector("tr:has-text('Åsa Ålander')"); check(pg.locator("tbody tr").count()==4,"4 medlemmar i registret efter två importer")
    check("Örjan Öberg" in pg.inner_text("tbody"),"å/ä/ö bevaras")
    # gräns
    sql(f"update product_entitlements set limits_override='{{\"max_members\":5}}' where workspace_id=(select id from workspaces where name='{ws}') and product='association_portal'")
    pg.reload(); pg.wait_for_selector("tr:has-text('Åsa Ålander')"); pg.click("button:has-text('Importera CSV')"); pg.set_input_files("div.modal input[type=file]",more); pg.wait_for_selector("div.modal:has-text('3 rader')")
    check("överskrida medlemsgränsen" in pg.inner_text("div.modal"),"förhandsgranskning varnar för överskriden gräns")
    check(pg.locator("div.modal button:has-text('Importera 3 medlemmar')").is_disabled(),"import avstängd när gränsen skulle överskridas")
    b.close()
print("\nRESULTAT:", "ALLA KONTROLLER OK" if not FAIL else f"{len(FAIL)} FEL"); sys.exit(1 if FAIL else 0)

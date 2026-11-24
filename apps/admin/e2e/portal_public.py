"""Föreningsportal: publik sida (opt-in). Samtycke, publicering av nyheter/turnering, anonym vy utan persondata, avstängning."""
import json,random,subprocess,sys,urllib.request
from playwright.sync_api import sync_playwright
FAIL=[]
def check(c,m):
    print(("OK   " if c else "FEL  ")+m)
    if not c: FAIL.append(m)
def sql(q): return subprocess.run(["psql","postgres://plattform:plattform_dev@localhost:5432/plattform_dev","-tAc",q],capture_output=True,text=True).stdout.strip()
def rsql(q): return subprocess.run(["su","postgres","-c",f"psql -d plattform_dev -tAc \"{q}\""],capture_output=True,text=True).stdout.strip()
tag=str(random.randint(10000,99999)); email=f"pub{tag}@example.test"; wsname=f"Pub-E2E {tag}"; slug=f"pub-e2e-{tag}"
req=urllib.request.Request("http://127.0.0.1:4000/api/v1/auth/register",method="POST",headers={"content-type":"application/json","x-requested-with":"platform-customer"},
    data=json.dumps({"email":email,"password":"Kundlösenord-2026","name":"Kund Pub","workspaceName":wsname,"products":["association_portal","tournament_system"],"acceptTerms":True}).encode())
urllib.request.urlopen(req).read()
wid=sql(f"select id from workspaces where name='{wsname}'")
with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_page(viewport={"width":1300,"height":900}); pg.goto("http://127.0.0.1:5175/")
    pg.fill("input[type=email]",email); pg.fill("input[type=password]","Kundlösenord-2026"); pg.click("button:has-text('Logga in')"); pg.wait_for_selector("h1:has-text('Nyheter')")
    H={"x-requested-with":"platform-customer","content-type":"application/json"}
    def api(m,path,body=None):
        r=pg.request.fetch(f"http://127.0.0.1:5175/api/v1{path}",method=m,headers=H,data=json.dumps(body) if body is not None else None); return r.status,(r.json() if r.text() else None)
    # data: medlem (får aldrig synas), publicerad nyhet, utkast, turnering med tre lag och ett resultat
    api("POST",f"/workspaces/{wid}/association/members",{"name":"Hemlig Medlem","email":"hemlig@example.test"})
    s,n=api("POST",f"/workspaces/{wid}/association/news",{"title":"Publik nyhet","body":"Välkommen!"}); api("POST",f"/workspaces/{wid}/association/news/{n['id']}/publish",{})
    api("POST",f"/workspaces/{wid}/association/news",{"title":"Internt utkast","body":"x"})
    s,t=api("POST",f"/workspaces/{wid}/tournaments",{"name":"Vårcupen"})
    for nm in ("Lag Alfa","Lag Beta","Lag Gamma"): api("POST",f"/workspaces/{wid}/tournaments/{t['id']}/teams",{"name":nm})
    api("POST",f"/workspaces/{wid}/tournaments/{t['id']}/start",{})
    s,d=api("GET",f"/workspaces/{wid}/tournaments/{t['id']}"); m=[x for x in d["matches"] if not x.get("bye")][0]
    api("PUT",f"/workspaces/{wid}/tournaments/{t['id']}/matches/{m['id']}",{"homeScore":3,"awayScore":1})
    check(api("PATCH",f"/workspaces/{wid}/tournaments/{t['id']}",{"isPublic":True})[0]==409,"turnering kan inte publiceras innan sidan är påslagen")
    anon=b.new_context().new_page(); anon.goto(f"http://127.0.0.1:5175/p/{slug}"); anon.wait_for_selector(".alert"); check("finns inte" in anon.inner_text("body"),"publik adress ger 'finns inte' innan något är påslaget")
    pg.click("nav a:has-text('Publik sida')"); pg.wait_for_selector("h1:has-text('Publik sida')")
    check(pg.locator(".badge:has-text('Av')").count()==1,"sidan är avstängd som standard")
    pg.fill("input[placeholder='min-forening']",slug)
    btn=pg.locator("button:has-text('Slå på publik sida')"); check(btn.is_disabled(),"knappen är låst utan samtycke")
    pg.check("input[type=checkbox] >> nth=1"); check(not btn.is_disabled(),"samtyckesruta låser upp knappen")
    btn.click(); pg.wait_for_selector("text=Sparat."); check(pg.locator(".badge:has-text('På')").count()==1,"sidan är påslagen")
    check(rsql(f"select consent_version is not null and consent_at is not null from public_pages where workspace_id='{wid}'")=="t","samtycke registrerat med tid och version")
    check(api("PATCH",f"/workspaces/{wid}/tournaments/{t['id']}",{"isPublic":True})[0]==200,"turnering publicerad uttryckligen")
    anon.goto(f"http://127.0.0.1:5175/p/{slug}"); anon.wait_for_selector("h1:has-text('"+wsname+"')")
    body=anon.inner_text("body")
    check("Publik nyhet" in body and "Vårcupen" in body,"anonym vy visar publicerad nyhet och vald turnering")
    check("Internt utkast" not in body and "Hemlig" not in body and "hemlig@example.test" not in body,"utkast och medlemsdata syns inte")
    check(anon.locator("meta[name=robots]").first.get_attribute("content").startswith("noindex"),"noindex satt")
    anon.click("a:has-text('Vårcupen')"); anon.wait_for_selector("h1:has-text('Vårcupen')"); tb=anon.inner_text("body")
    check("Lag Alfa" in tb and "Lag Beta" in tb and "3–1" in tb,"turneringssidan visar lagnamn, tabell och resultat")
    check("hemlig" not in tb.lower() and wid not in anon.content(),"ingen persondata eller arbetsyte-id i turneringsvyn")
    pg.click("button:has-text('Stäng av')"); pg.wait_for_selector("text=Sparat."); anon.reload(); anon.wait_for_selector(".alert"); check("finns inte" in anon.inner_text("body"),"avstängning döljer sidan direkt")
    check(rsql(f"select is_public from tournaments where workspace_id='{wid}'")=="f","turneringens publicering återställd vid avstängning")
sys.exit(1 if FAIL else 0)

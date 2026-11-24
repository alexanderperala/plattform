"""Fakturering: plan, faktureringsuppgifter, checkout (testadapter), webhook-signerade statusändringar och fakturor (browser)."""
import hmac,hashlib,json,random,subprocess,sys,time,urllib.request
from playwright.sync_api import sync_playwright
SECRET="whsec_e2e"; FAIL=[]
def check(c,m):
    print(("OK   " if c else "FEL  ")+m)
    if not c: FAIL.append(m)
def hook(type_,obj):
    body=json.dumps({"id":f"evt_{random.randint(1,10**9)}","type":type_,"data":{"object":obj}}); t=int(time.time())
    sig=hmac.new(SECRET.encode(),f"{t}.{body}".encode(),hashlib.sha256).hexdigest()
    req=urllib.request.Request("http://127.0.0.1:4000/api/webhooks/stripe",data=body.encode(),method="POST",headers={"content-type":"application/json","stripe-signature":f"t={t},v1={sig}"})
    return json.loads(urllib.request.urlopen(req).read())["outcome"]
def rsql(q): return subprocess.run(["su","postgres","-c",f"psql -d plattform_dev -tAc \"{q}\""],capture_output=True,text=True).stdout.strip()
tag=str(random.randint(10000,99999)); email=f"bill{tag}@example.test"; org=f"Bill-E2E {tag}"
with sync_playwright() as p:
    b=p.chromium.launch(); cu=b.new_page(viewport={"width":1300,"height":900}); cu.goto("http://127.0.0.1:5174/")
    cu.click("text=Skapa konto"); cu.fill("form input >> nth=0","Eva Ekonomi"); cu.fill("input[type=email]",email); cu.fill("input[type=password]","Kundlösenord-2026")
    cu.fill("form >> input >> nth=3",org); cu.check("text=Jag godkänner villkoren"); cu.click("button:has-text('Skapa konto')"); cu.wait_for_selector(f"h1:has-text('{org}')")
    wid=rsql(f"select id from workspaces where name='{org}'")
    cu.click("nav a:has-text('Fakturering')"); cu.wait_for_selector("h1:has-text('Fakturering')")
    check(cu.locator("[data-testid=plan]").count()==3,"tre betalplaner visas (utan provperioden)"); check("exklusive moms" in cu.inner_text("main"),"priser anges exklusive moms")
    check("Provperiod" in cu.inner_text("main"),"nuvarande status är provperiod")
    cu.click("[data-testid=plan]:has-text('Standard') button:has-text('Välj månadsvis')"); cu.wait_for_selector("text=faktureringsuppgifter"); check(True,"köp utan faktureringsuppgifter nekas med tydligt meddelande")
    cu.fill("form:has-text('Företag/förening') >> input >> nth=0","Förening AB"); cu.fill("input[placeholder='556677-8899']","123"); 
    for sel,v in (("form:has-text('Företag/förening') >> input >> nth=4","Storgatan 1"),("form:has-text('Företag/förening') >> input >> nth=5","111 22"),("form:has-text('Företag/förening') >> input >> nth=6","Stockholm"),("input[type=email]","ekonomi@example.test")):
        cu.fill(sel,v)
    cu.click("button:has-text('Spara uppgifter')"); cu.wait_for_selector(".alert"); check("10 siffror" in cu.locator(".alert").first.inner_text(),"ogiltigt organisationsnummer avvisas")
    cu.fill("input[placeholder='556677-8899']","556677-8899"); cu.click("button:has-text('Spara uppgifter')"); cu.wait_for_selector("text=Sparat.")
    check(rsql(f"select org_number from workspace_billing_profiles where workspace_id='{wid}'")=="556677-8899","faktureringsuppgifter sparade")
    cu.click("[data-testid=plan]:has-text('Standard') button:has-text('Välj månadsvis')"); cu.wait_for_url("**/billing?checkout=success*"); cu.wait_for_selector("text=Betalningen behandlas")
    check(rsql(f"select status from subscriptions where workspace_id='{wid}'")=="Trialing","köpet aktiveras inte förrän leverantörens webhook kommit")
    oc=hook("checkout.session.completed",{"client_reference_id":wid,"customer":f"cus_{tag}","subscription":f"sub_{tag}","metadata":{"workspace_id":wid,"plan_id":"standard","interval":"month"}}); check(oc=="applied","signerad webhook accepteras")
    cu.reload(); cu.wait_for_selector("h1:has-text('Fakturering')"); cu.wait_for_selector(".badge:has-text('Aktivt')"); check("Standard" in cu.inner_text("main section >> nth=0"),"abonnemanget visas som Aktivt, plan Standard")
    check(cu.locator("button:has-text('Hantera betalsätt')").count()==1,"portalknapp visas när betalkonto finns")
    hook("invoice.payment_failed",{"customer":f"cus_{tag}","subscription":f"sub_{tag}"}); cu.reload(); cu.wait_for_selector("text=Förfallen betalning"); check("raderas inte" in cu.inner_text("main"),"förfallen betalning visar varning om att data inte raderas")
    cu.screenshot(path="/home/claude/plattform/docs/screenshots/customer-billing-pastdue.png")
    hook("invoice.paid",{"id":f"in_{tag}","number":f"E2E-{tag}","customer":f"cus_{tag}","subscription":f"sub_{tag}","amount_paid":39900,"tax":9975,"currency":"sek","hosted_invoice_url":"https://pay.example.test/x"})
    cu.reload(); cu.wait_for_selector(f"td:has-text('E2E-{tag}')"); check(cu.locator(".badge:has-text('Aktivt')").count()==1,"efter betald faktura är abonnemanget Aktivt igen")
    check("399" in cu.locator("tbody tr").first.inner_text() and "99,75" in cu.locator("tbody tr").first.inner_text().replace("\xa0"," "),"fakturan visas med belopp och moms")
    try: urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:4000/api/webhooks/stripe",data=b"{}",method="POST",headers={"content-type":"application/json","stripe-signature":"t=1,v1=00"})); check(False,"osignerad webhook avvisas")
    except urllib.error.HTTPError as e: check(e.code==400,"osignerad webhook avvisas med 400")
    b.close()
print("\nRESULTAT:","ALLA KONTROLLER OK" if not FAIL else f"{len(FAIL)} FEL"); sys.exit(1 if FAIL else 0)

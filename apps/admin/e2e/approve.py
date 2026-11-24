import hmac,hashlib,base64,struct,time,subprocess
from playwright.sync_api import sync_playwright
def totp(s):
    k=base64.b32decode(s); c=int(time.time())//30
    h=hmac.new(k,struct.pack(">Q",c),hashlib.sha1).digest(); o=h[-1]&15
    return "%06d"%((struct.unpack(">I",h[o:o+4])[0]&0x7fffffff)%1000000)
S="JBSWY3DPEHPK3PXP"
def login(pg,email):
    pg.goto("http://127.0.0.1:5173/"); pg.fill('input[type=email]',email); pg.fill('input[type=password]',"DevAdminPassword!2026"); pg.click("text=Fortsätt")
    pg.wait_for_selector("text=Tvåstegsverifiering"); 
    pg.fill("input",totp(S)); pg.click("button:has-text('Verifiera')"); pg.wait_for_selector("h1:has-text('Översikt')")
def sql(q): return subprocess.run(["psql","postgres://plattform:plattform_dev@localhost:5432/plattform_dev","-tAc",q],capture_output=True,text=True).stdout.strip()
with sync_playwright() as p:
    b=p.chromium.launch(); pg=b.new_page(); login(pg,"owner@example.test")
    sql("update platform_admin_sessions set reauth_at = now() - interval '20 minutes' where admin_id=(select id from platform_admins where email='owner@example.test')")
    pg.click("nav a[href='/approvals']"); pg.wait_for_selector("text=Four-eyes test via UI")
    pg.click("tr:has-text('Four-eyes test via UI') button:has-text('Godkänn')"); 
    pg.click("div.modal button:has-text('Godkänn')")
    pg.wait_for_selector("text=Bekräfta din identitet",timeout=4000); print("reauth-dialog visades vid godkännande")
    time.sleep(31-(time.time()%30)+1) if (time.time()%30)>26 else None
    pg.fill("input[autocomplete=one-time-code]",totp(S)); pg.click("button:has-text('Bekräfta och utför')")
    pg.wait_for_selector("tr:has-text('Four-eyes test via UI'):has-text('Utförd')",timeout=6000); print("godkänd och utförd i UI")
    b.close()
print(sql("select status from workspaces where name='Malmö Bordtennisklubb'"))
print(sql("select action, self_approved from admin_audit_log order by at desc limit 3"))

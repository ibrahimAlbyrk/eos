// The exe's icon and version info. Only a Windows host has the resource
// compiler; a check from another system builds without them.
fn main() {
    println!("cargo:rerun-if-env-changed=EOS_VERSION");
    #[cfg(windows)]
    {
        let mut res = winresource::WindowsResource::new();
        res.set_icon("../build/icon.ico");
        res.set("ProductName", "Eos");
        res.set("FileDescription", "Eos Setup");
        res.set("CompanyName", "Eos");
        if let Ok(v) = std::env::var("EOS_VERSION") {
            res.set("ProductVersion", &v);
        }
        res.compile().expect("compile Windows resources");
    }
}

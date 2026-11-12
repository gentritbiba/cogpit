use std::process::ExitCode;

#[tokio::main]
async fn main() -> ExitCode {
    cogpit_core::init_logging();
    match cogpit_core::run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("cogpit-core: {error}");
            ExitCode::FAILURE
        }
    }
}

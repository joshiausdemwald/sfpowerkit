import { core, flags, SfdxCommand } from "@salesforce/command";
import { AnyJson } from "@salesforce/ts-types";
import { JsonArray } from "@salesforce/ts-types";
import { SfdxProject, SfdxError } from "@salesforce/core";
import * as xml2js from "xml2js";
import * as util from "util";
import * as fs from "fs-extra";
import * as rimraf from "rimraf";
import * as path from "path";
import { SFPowerkit, LoggerLevel } from "../../../sfpowerkit";

const spawn = require("child-process-promise").spawn;

// Initialize Messages with the current plugin directory
core.Messages.importMessagesDirectory(__dirname);

// Load the specific messages for this file. Messages from @salesforce/command, @salesforce/core,
// or any library that is using the messages framework can also be loaded this way.
const messages = core.Messages.loadMessages("sfpowerkit", "valid");

export default class Valid extends SfdxCommand {
  public static description = messages.getMessage("commandDescription");

  public static examples = [
    `$ sfdx sfpowerkit:package:valid -n testPackage
  Now analyzing testPackage
Converting package testPackage
Elements supported included in your package testPackage
[
  "AuraDefinitionBundle",
  "CustomApplication",
  "ApexClass",
  "ContentAsset",
  "WorkflowRule"
]
  `
  ];

  protected static flagsConfig = {
    package: flags.string({
      required: false,
      char: "n",
      description: messages.getMessage("packageFlagDescription")
    }),
    bypass: flags.array({
      required: false,
      char: "b",
      description: messages.getMessage("itemsToBypassValidationDescription")
    }),
    apiversion: flags.builtin({
      description: messages.getMessage("apiversion")
    }),
    loglevel: flags.enum({
      description: "loglevel to execute the command",
      default: "info",
      required: false,
      options: [
        "trace",
        "debug",
        "info",
        "warn",
        "error",
        "fatal",
        "TRACE",
        "DEBUG",
        "INFO",
        "WARN",
        "ERROR",
        "FATAL"
      ]
    })
  };

  // Comment this out if your command does not require an org username
  //protected static requiresUsername = true;

  // Comment this out if your command does not support a hub org username
  // protected static supportsDevhubUsername = true;

  // Set this to true if your command requires a project workspace; 'requiresProject' is false by default
  protected static requiresProject = true;

  private coverageJSON;

  public async run(): Promise<AnyJson> {
    rimraf.sync("temp_sfpowerkit");

    SFPowerkit.setLogLevel(this.flags.loglevel, this.flags.json);
    // Getting Project config
    const project = await SfdxProject.resolve();

    const projectJson = await project.retrieveSfdxProjectJson();

    let resourcePath = path.join(
      __dirname,
      "..",
      "..",
      "..",
      "..",
      "resources",
      "metadata.json"
    );

    let fileData = fs.readFileSync(resourcePath, "utf8");
    this.coverageJSON = JSON.parse(fileData);

    if (this.isNotDefaultApiVersion()) {
      this.useCustomCoverageJSON();
    }

    let packageToBeScanned = this.flags.package;

    const packageDirectories =
      (projectJson.get("packageDirectories") as JsonArray) || [];
    const result_store = [];

    if (packageToBeScanned != undefined) {
      SFPowerkit.log(`Analyzing ${packageToBeScanned}`, LoggerLevel.INFO);
      for (const sf_package of packageDirectories as JsonArray) {
        if (
          packageToBeScanned != undefined &&
          packageToBeScanned === sf_package["package"]
        ) {
          SFPowerkit.log(
            `located ${packageToBeScanned} in project ${sf_package["path"]}`,
            LoggerLevel.DEBUG
          );
          let result;
          try {
            result = await this.validate(sf_package);
          } catch (e) {
            SFPowerkit.log(
              `Error Occured Unable to analyze ${sf_package["package"]}`,
              LoggerLevel.ERROR
            );
          }

          break;
        }
      }
    } else {
      SFPowerkit.log(
        "All packaging directories are  being analyzed",
        LoggerLevel.INFO
      );

      for (const sf_package of packageDirectories as JsonArray) {
        if (sf_package["package"] != undefined) {
          SFPowerkit.log(
            `Analyzing ${sf_package["package"]}`,
            LoggerLevel.DEBUG
          );
          let result;
          try {
            result = await this.validate(sf_package);
            result_store.push(result);
          } catch (e) {
            SFPowerkit.log(
              `Unable to analyze ${sf_package["package"]}, Skipping ${sf_package["package"]}. try running sfdx force:source:convert -r ${sf_package["path"]}`,
              LoggerLevel.WARN
            );
          }
        }
      }
    }

    if (!this.flags.json) {
      result_store.forEach(element => {
        if (element.valid == false)
          throw new SfdxError("Analysis Failed, Unsupported metadata present");
      });
    }
    return { packages: result_store };
  }

  public async validate(packageToBeScanned: AnyJson) {
    var sfdx_package = new SFDXPackage();

    sfdx_package.packageName = packageToBeScanned["package"];

    // Split arguments to use spawn
    const args = [];
    args.push("force:source:convert");

    // outputdir
    args.push("-d");
    args.push("temp_sfpowerkit/mdapi");

    // package name
    args.push("-n");
    args.push(`${packageToBeScanned["package"]}`);

    args.push("-r");
    args.push(`${packageToBeScanned["path"]}`);

    args.push("--json");
    // INSTALL PACKAGE

    SFPowerkit.log(
      `Utilizing Version of the metadata coverage ${this.coverageJSON.versions.selected}`,
      LoggerLevel.DEBUG
    );
    SFPowerkit.log(
      `Converting package ${packageToBeScanned["package"]}`,
      LoggerLevel.INFO
    );

    //Bypass package validation
    if (this.flags.bypass) {
      sfdx_package.typesToBypass = this.flags.bypass;
    }

    var startTime = new Date().valueOf();
    await spawn("sfdx", args, { silent: true });

    let targetFilename = "temp_sfpowerkit/mdapi/package.xml";

    if (fs.existsSync(targetFilename)) {
      const parser = new xml2js.Parser({ explicitArray: false });
      const parseString = util.promisify(parser.parseString);
      const existing = await parseString(fs.readFileSync(targetFilename));

      if (Array.isArray(existing.Package.types)) {
        for (const types of existing.Package.types as JsonArray) {
          if (this.coverageJSON.types[types["name"]] != undefined)
            if (
              this.coverageJSON.types[types["name"]].channels
                .unlockedPackagingWithoutNamespace
            )
              sfdx_package.supportedTypes.push(`${types["name"]}`);
            else sfdx_package.unsupportedtypes.push(`${types["name"]}`);
        }
      } else {
        if (
          this.coverageJSON.types[existing.Package.types["name"]] != undefined
        )
          if (
            this.coverageJSON.types[existing.Package.types["name"]].channels
              .unlockedPackagingWithoutNamespace
          )
            sfdx_package.supportedTypes.push(
              `${existing.Package.types["name"]}`
            );
          else
            sfdx_package.unsupportedtypes.push(
              `${existing.Package.types["name"]}`
            );
      }

      sfdx_package.processed = true;

      if (sfdx_package.supportedTypes.length > 0) {
        this.ux.log(
          `Supported metadata in package ${packageToBeScanned["package"]}`
        );
        sfdx_package.supportedTypes.forEach(element => {
          this.ux.log(element);
        });
        sfdx_package.valid = true;
        this.ux.log(
          `--------------------------------------------------------------------------------`
        );
      }

      //Bypass metadata in package validator
      if (
        sfdx_package.typesToBypass.length > 0 &&
        sfdx_package.unsupportedtypes.length > 0
      ) {
        let itemsToRemove = [];

        sfdx_package.typesToBypass = sfdx_package.typesToBypass.map(element =>
          element.toLowerCase()
        );
        sfdx_package.unsupportedtypes = sfdx_package.unsupportedtypes.map(
          element => element.toLowerCase()
        );

        itemsToRemove = sfdx_package.typesToBypass.filter(element =>
          sfdx_package.unsupportedtypes.includes(element)
        );

        if (itemsToRemove.length > 0) {
          this.ux.log(
            `Unsupported metadata in package ${packageToBeScanned["package"]}  to bypass`
          );
          itemsToRemove.forEach(element => {
            this.ux.log(element);
          });
          sfdx_package.unsupportedtypes = sfdx_package.unsupportedtypes.filter(
            element => !itemsToRemove.includes(element)
          );
          this.ux.log(
            `--------------------------------------------------------------------------------`
          );
        }
      }

      if (sfdx_package.unsupportedtypes.length > 0) {
        this.ux.log(
          `Unsupported metadata in package ${packageToBeScanned["package"]}`
        );
        sfdx_package.unsupportedtypes.forEach(element => {
          this.ux.log(element);
        });
        sfdx_package.valid = false;
        this.ux.log(
          `--------------------------------------------------------------------------------`
        );
      }
    }

    rimraf.sync("temp_sfpowerkit");

    return sfdx_package;
  }

  public useCustomCoverageJSON(): void {
    try {
      let resourcePath = path.join(
        __dirname,
        "..",
        "..",
        "..",
        "..",
        "resources",
        `metadata_v${this.flags.apiversion}.json`
      );
      let fileData = fs.readFileSync(resourcePath, "utf8");
      this.coverageJSON = JSON.parse(fileData);
    } catch (fileError) {
      throw new SfdxError(
        `Unable to read version ${this.flags.apiversion} of metadata coverage JSON`
      );
    }
  }

  public isNotDefaultApiVersion(): boolean {
    return (
      this.flags.apiversion &&
      this.coverageJSON.versions.selected != this.flags.apiversion
    );
  }
}

export class SFDXPackage {
  public unsupportedtypes = [];
  public supportedTypes = [];
  public typesToBypass = [];
  public packageName: string;
  public valid: boolean;
  public processed: boolean;
}
